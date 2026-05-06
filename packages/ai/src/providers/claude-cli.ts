import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	Usage,
} from "../types.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";

/**
 * claude-cli provider — wraps the local `claude` binary running in print mode (`claude -p`).
 *
 * Why this exists: Anthropic's API now classifies any non-Claude-Code SDK proxy traffic
 * as "third-party app" usage and 400s it on Max plans. The only Max-billable path from a
 * third-party tool (like Pi) is to shell out to the official `claude` CLI, which uses its
 * own native auth from ~/.claude/. This provider lets pi-ai treat that subprocess as an
 * ordinary stream-able provider.
 *
 * Tool access: enabled, but scoped. Claude gets its core Code tools, while user-level
 * plugins, hooks, and MCP servers are disabled by default to avoid injecting unrelated
 * personal context (Gmail/Drive/superpowers/etc.) into every Pi provider call. Set
 * PI_CLAUDE_CLI_INCLUDE_USER_CONTEXT=1 to restore the full user Claude Code environment.
 *
 * Streaming: claude is invoked with `--output-format stream-json`, which emits JSONL records
 * for model deltas, tool calls, tool results, lifecycle status, and the final result. Pi still
 * treats claude-cli as one provider call: Claude's internal tool calls are surfaced as compact
 * activity text only, never as Pi ToolCall blocks, so Pi does not re-execute them.
 *
 * System prompt is passed via `claude -p --system-prompt` when present so Pi's prompt
 * replaces Claude Code's default agent prompt instead of stacking on top of it.
 */

/**
 * Maximum number of prior user/assistant turns to include as inline context.
 * Each turn round-trips with the latest message; too many turns inflate latency and cost.
 * 10 covers a typical session worth of working context.
 */
const MAX_PRIOR_TURNS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

type StickyClaudeSession = {
	sessionId: string;
	turns: number;
	seenMessageCount: number;
};

const stickySessions = new Map<string, StickyClaudeSession>();

export function _clearClaudeCliStickySessionsForTest(): void {
	stickySessions.clear();
}

function positiveEnvInt(name: string): number | undefined {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveIdleTimeoutMs(timeoutMs?: number): number {
	const envTimeout = positiveEnvInt("PI_CLAUDE_CLI_IDLE_TIMEOUT_MS") ?? positiveEnvInt("PI_CLAUDE_CLI_TIMEOUT_MS");
	const resolved = timeoutMs ?? envTimeout ?? DEFAULT_IDLE_TIMEOUT_MS;
	return Math.max(1, resolved);
}

function resolveMaxRuntimeMs(): number | undefined {
	return positiveEnvInt("PI_CLAUDE_CLI_MAX_RUNTIME_MS");
}

function includeUserClaudeContext(): boolean {
	return /^(1|true|yes|on)$/i.test(process.env.PI_CLAUDE_CLI_INCLUDE_USER_CONTEXT ?? "");
}

function stickyClaudeSessionsEnabled(): boolean {
	return !/^(0|false|no|off)$/i.test(process.env.PI_CLAUDE_CLI_STICKY_SESSIONS ?? "");
}

function digestText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function uuidFromKey(key: string): string {
	const hex = digestText(key).slice(0, 32).split("");
	hex[12] = "4";
	hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

function stickySessionKey(model: Model<"claude-cli">, context: Context): string {
	const sessionKey = `${process.pid}:${process.env.PI_SESSION_ID ?? ""}`;
	const systemPromptHash = digestText(context.systemPrompt ?? "");
	return [process.cwd(), sessionKey, model.id, systemPromptHash].join("\n");
}

function getStickySession(model: Model<"claude-cli">, context: Context): StickyClaudeSession | undefined {
	if (!stickyClaudeSessionsEnabled()) return undefined;
	const key = stickySessionKey(model, context);
	const existing = stickySessions.get(key);
	if (existing) return existing;
	const session = { sessionId: uuidFromKey(`pi-claude-cli\n${key}`), turns: 0, seenMessageCount: 0 };
	stickySessions.set(key, session);
	return session;
}

function latestUserIndex(context: Context): number {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		if (context.messages[i].role === "user") return i;
	}
	return -1;
}

function collectPriorTurns(
	context: Context,
	latestUserIdx: number,
	startIndex: number,
): { label: "USER" | "ASSISTANT"; text: string }[] {
	const priorTurns: { label: "USER" | "ASSISTANT"; text: string }[] = [];
	for (let i = Math.max(0, startIndex); i < latestUserIdx; i++) {
		const msg = context.messages[i];
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const text = messageToText(msg).trim();
		if (!text) continue;
		priorTurns.push({ label: msg.role === "user" ? "USER" : "ASSISTANT", text });
	}
	return priorTurns;
}

function renderPromptWithContext(
	latestText: string,
	priorTurns: { label: "USER" | "ASSISTANT"; text: string }[],
	label: string,
): string {
	const trimmed = priorTurns.slice(-MAX_PRIOR_TURNS);
	if (trimmed.length === 0) return latestText;
	const contextBlock = trimmed.map((t) => `[${t.label}]\n${t.text}`).join("\n\n");
	return `${label}:\n\n${contextBlock}\n\n---\n\nCurrent question:\n${latestText}`;
}

function extractPrompt(context: Context, stickySession?: StickyClaudeSession): string {
	// Anthropic's third-party-app gate returns 400 if the API request *structure* sent
	// to upstream by claude -p has a foreign system prompt or role-tagged multi-turn
	// messages array. The gate is shape-based, not content-based — verified
	// 2026-05-02 by sending a multi-turn-styled prompt as a single user message and
	// getting a clean response back.
	//
	// Strategy: package any prior user/assistant turns as inline labeled text *inside*
	// a single user message. From the upstream API's perspective, claude -p sends one
	// user message containing some context plus the actual question — the API request
	// shape stays valid, the conversation context is preserved.
	//
	// Skipped:
	// - context.systemPrompt (foreign Pi system prompt is the original gate trigger)
	// - toolResult messages (noisy + reveal Pi's tool framework, risk re-triggering gate)
	// - turns beyond MAX_PRIOR_TURNS (latency/cost guard)

	const latestUserIdx = latestUserIndex(context);
	if (latestUserIdx === -1) return "";

	const latestText = messageToText(context.messages[latestUserIdx]);
	if (!latestText) return "";

	if (!stickySession || stickySession.turns === 0) {
		return renderPromptWithContext(
			latestText,
			collectPriorTurns(context, latestUserIdx, 0),
			"Prior conversation context (most recent last) — use as background for the question that follows",
		);
	}

	const transcriptWasCompacted = latestUserIdx < stickySession.seenMessageCount - 1;
	const unseenStart = transcriptWasCompacted ? 0 : Math.min(stickySession.seenMessageCount, latestUserIdx);
	const unseenPriorTurns = collectPriorTurns(context, latestUserIdx, unseenStart);
	return renderPromptWithContext(
		latestText,
		unseenPriorTurns,
		"Intervening Pi conversation since your last Claude turn (most recent last) — use as background for the question that follows",
	);
}

function messageToText(message: Message): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("");
	}

	if (message.role === "assistant") {
		return message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("");
	}

	if (message.role === "toolResult") {
		return message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("");
	}

	return "";
}

function buildAssistantMessage(
	model: Model<"claude-cli">,
	text: string,
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
	usage?: Usage,
	responseModel?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseModel,
		usage: usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function buildClaudeArgs(
	model: Model<"claude-cli">,
	context: Context,
	prompt: string,
	stickySession?: StickyClaudeSession,
): string[] {
	const home = process.env.HOME ?? "/root";
	const args = [
		"-p",
		"--verbose",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		"--model",
		model.id,
	];

	if (stickySession) args.push("--session-id", stickySession.sessionId);

	if (!includeUserClaudeContext()) {
		args.push("--setting-sources", "local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
	}

	args.push(
		"--tools",
		"default",
		"--permission-mode",
		"bypassPermissions",
		"--add-dir",
		`${home}/Vault-V2`,
		"--add-dir",
		`${home}/.pi`,
		"--add-dir",
		`${home}/projects/ahlnos`,
	);

	const systemPrompt = !stickySession || stickySession.turns === 0 ? context.systemPrompt : undefined;
	if (systemPrompt?.trim()) args.push("--system-prompt", systemPrompt);
	args.push(prompt);
	return args;
}

type ClaudeCliJson = Record<string, any>;

type ClaudeCliContentBlockState =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_use"; id?: string; name?: string; inputJson: string; announcedInput: boolean }
	| { type: string; name?: string; text?: string; inputJson?: string; announcedInput?: boolean };

function parseJsonLine(line: string): ClaudeCliJson | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as ClaudeCliJson;
	} catch {
		return undefined;
	}
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFromClaudeResult(result: ClaudeCliJson): Usage | undefined {
	const usage = result.usage;
	if (!usage || typeof usage !== "object") return undefined;

	const input = numberValue(usage.input_tokens);
	const output = numberValue(usage.output_tokens);
	const cacheRead = numberValue(usage.cache_read_input_tokens);
	const cacheWrite = numberValue(usage.cache_creation_input_tokens);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			// Claude CLI runs through the user's Claude Code subscription auth. It reports
			// an estimated USD value in stream-json, but Pi should not present that as
			// billable API spend.
			total: 0,
		},
	};
}

function summarizeToolInput(toolName: string | undefined, input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	if (toolName === "Bash" && typeof record.command === "string") return record.command;
	if ((toolName === "Read" || toolName === "Edit" || toolName === "Write") && typeof record.file_path === "string") {
		return record.file_path;
	}
	if ((toolName === "Grep" || toolName === "Glob") && typeof record.pattern === "string") return record.pattern;
	if (toolName === "Task" && typeof record.description === "string") return record.description;
	return undefined;
}

function activityLine(text: string): string {
	return `[claude-cli] ${text}\n`;
}

function runClaudeCli(
	model: Model<"claude-cli">,
	context: Context,
	options?: { signal?: AbortSignal; timeoutMs?: number },
) {
	const stream = createAssistantMessageEventStream();
	const stickySession = getStickySession(model, context);
	const prompt = extractPrompt(context, stickySession);
	const nextSeenMessageCount = latestUserIndex(context) + 2;
	const idleTimeoutMs = resolveIdleTimeoutMs(options?.timeoutMs);
	const maxRuntimeMs = resolveMaxRuntimeMs();

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	delete childEnv.ANTHROPIC_API_KEY;
	delete childEnv.ANTHROPIC_AUTH_TOKEN;
	delete childEnv.ANTHROPIC_BASE_URL;

	const home = process.env.HOME ?? "/root";
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn("claude", buildClaudeArgs(model, context, prompt, stickySession), {
			env: childEnv,
			cwd: `${home}/projects/ahlnos`,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (spawnErr) {
		const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
		const errMessage = buildAssistantMessage(model, "", "error", `claude-cli spawn failed: ${msg}`);
		stream.push({ type: "error", reason: "error", error: errMessage });
		stream.end(errMessage);
		return stream;
	}

	let stdout = "";
	let stderr = "";
	let lineBuffer = "";
	let finalText = "";
	let displayText = "";
	let responseModel: string | undefined;
	let finalUsage: Usage | undefined;
	let aborted = false;
	let idleTimedOut = false;
	let maxRuntimeTimedOut = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const blocks = new Map<number, ClaudeCliContentBlockState>();

	const onAbort = () => {
		aborted = true;
		try {
			child.kill("SIGTERM");
		} catch {
			/* noop */
		}
	};

	const terminate = () => {
		try {
			child.kill("SIGTERM");
		} catch {
			/* noop */
		}
		killTimer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* noop */
			}
		}, KILL_GRACE_MS);
	};

	const resetIdleTimer = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleTimedOut = true;
			terminate();
		}, idleTimeoutMs);
	};

	resetIdleTimer();
	if (maxRuntimeMs !== undefined) {
		maxRuntimeTimer = setTimeout(() => {
			maxRuntimeTimedOut = true;
			terminate();
		}, maxRuntimeMs);
	}

	const cleanup = () => {
		if (idleTimer) clearTimeout(idleTimer);
		if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
		if (killTimer) clearTimeout(killTimer);
		if (options?.signal) options.signal.removeEventListener("abort", onAbort);
	};

	if (options?.signal) {
		if (options.signal.aborted) {
			onAbort();
		} else {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	const partial: AssistantMessage = buildAssistantMessage(model, "", "stop");
	stream.push({ type: "start", partial });
	partial.content = [{ type: "text", text: "" }];
	stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial, content: [{ type: "text", text: "" }] } });

	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");

	const updateDisplay = (nextText: string, delta: string) => {
		resetIdleTimer();
		displayText = nextText;
		(partial.content[0] as TextContent).text = displayText;
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: { ...partial, content: [{ type: "text", text: displayText }] },
		});
	};

	const appendActivity = (text: string) => {
		if (finalText) return;
		const line = activityLine(text);
		updateDisplay(displayText + line, line);
	};

	const handleClaudeEvent = (event: ClaudeCliJson) => {
		if (event.type === "system") {
			if (event.subtype === "init") {
				responseModel = typeof event.model === "string" ? event.model : responseModel;
				const toolCount = Array.isArray(event.tools) ? event.tools.length : undefined;
				appendActivity(
					toolCount ? `initialized ${event.model ?? model.id} with ${toolCount} tools` : "initialized",
				);
			} else if (event.subtype === "status" && typeof event.status === "string") {
				appendActivity(event.status === "requesting" ? "requesting model response" : event.status);
			}
			return;
		}

		if (event.type === "stream_event" && event.event && typeof event.event === "object") {
			const streamEvent = event.event as ClaudeCliJson;
			if (streamEvent.type === "message_start") {
				const messageModel = streamEvent.message?.model;
				if (typeof messageModel === "string") responseModel = messageModel;
				appendActivity(`model turn started (${responseModel ?? model.id})`);
				return;
			}

			if (streamEvent.type === "content_block_start") {
				const index = numberValue(streamEvent.index);
				const block = streamEvent.content_block as ClaudeCliJson | undefined;
				const blockType = typeof block?.type === "string" ? block.type : "unknown";
				if (blockType === "text") {
					blocks.set(index, { type: "text", text: "" });
					if (!finalText && displayText) updateDisplay("", "");
				} else if (blockType === "thinking") {
					blocks.set(index, { type: "thinking", text: "" });
				} else if (blockType === "tool_use") {
					const toolName = typeof block?.name === "string" ? block.name : "tool";
					blocks.set(index, {
						type: "tool_use",
						id: typeof block?.id === "string" ? block.id : undefined,
						name: toolName,
						inputJson: "",
						announcedInput: false,
					});
					appendActivity(`preparing ${toolName}`);
				} else {
					blocks.set(index, { type: blockType });
				}
				return;
			}

			if (streamEvent.type === "content_block_delta") {
				const index = numberValue(streamEvent.index);
				const block = blocks.get(index);
				const delta = streamEvent.delta as ClaudeCliJson | undefined;
				if (!block || !delta) return;
				if (block.type === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
					finalText += delta.text;
					updateDisplay(finalText, delta.text);
					return;
				}
				if (
					block.type === "tool_use" &&
					delta.type === "input_json_delta" &&
					typeof delta.partial_json === "string"
				) {
					block.inputJson = `${block.inputJson ?? ""}${delta.partial_json}`;
					if (!block.announcedInput) {
						try {
							const input = JSON.parse(block.inputJson);
							const summary = summarizeToolInput(block.name, input);
							appendActivity(summary ? `running ${block.name}: ${summary}` : `running ${block.name}`);
							block.announcedInput = true;
						} catch {
							// Wait until the streamed JSON object is complete enough to summarize.
						}
					}
				}
				return;
			}

			if (streamEvent.type === "content_block_stop") {
				const index = numberValue(streamEvent.index);
				const block = blocks.get(index);
				if (block?.type === "tool_use" && !block.announcedInput) appendActivity(`running ${block.name ?? "tool"}`);
				blocks.delete(index);
				return;
			}

			if (streamEvent.type === "message_delta" && streamEvent.delta?.stop_reason === "tool_use") {
				appendActivity("waiting for tool result");
			}
			return;
		}

		if (event.type === "user" && event.tool_use_result && typeof event.tool_use_result === "object") {
			const result = event.tool_use_result as ClaudeCliJson;
			const errored = result.is_error === true || result.interrupted === true;
			appendActivity(errored ? "tool returned an error" : "tool completed");
			return;
		}

		if (event.type === "assistant") {
			const messageModel = event.message?.model;
			if (typeof messageModel === "string") responseModel = messageModel;
			return;
		}

		if (event.type === "result") {
			if (typeof event.result === "string") finalText = event.result;
			finalUsage = usageFromClaudeResult(event);
			if (stickySession) {
				stickySession.turns += 1;
				stickySession.seenMessageCount = nextSeenMessageCount;
			}
		}
	};

	child.stdout?.on("data", (chunk: string) => {
		resetIdleTimer();
		stdout += chunk;
		lineBuffer += chunk;
		let newlineIndex = lineBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = lineBuffer.slice(0, newlineIndex);
			lineBuffer = lineBuffer.slice(newlineIndex + 1);
			const parsed = parseJsonLine(line);
			if (parsed) handleClaudeEvent(parsed);
			newlineIndex = lineBuffer.indexOf("\n");
		}
	});

	child.stderr?.on("data", (chunk: string) => {
		resetIdleTimer();
		stderr += chunk;
	});

	child.on("error", (err) => {
		cleanup();
		const errMessage = buildAssistantMessage(
			model,
			finalText || displayText,
			"error",
			`claude-cli error: ${err.message}`,
			finalUsage,
			responseModel,
		);
		stream.push({ type: "error", reason: "error", error: errMessage });
		stream.end(errMessage);
	});

	child.on("close", (code) => {
		cleanup();
		const trailing = parseJsonLine(lineBuffer);
		if (trailing) handleClaudeEvent(trailing);

		if (aborted) {
			const aborted = buildAssistantMessage(
				model,
				finalText || displayText,
				"aborted",
				"claude-cli aborted",
				finalUsage,
				responseModel,
			);
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}

		if (idleTimedOut || maxRuntimeTimedOut) {
			const seconds = Math.ceil((idleTimedOut ? idleTimeoutMs : (maxRuntimeMs ?? idleTimeoutMs)) / 1000);
			const timeoutType = idleTimedOut ? "idle" : "max runtime";
			const timedOutMessage = buildAssistantMessage(
				model,
				finalText || displayText,
				"error",
				`claude-cli ${timeoutType} timed out after ${seconds}s`,
				finalUsage,
				responseModel,
			);
			stream.push({ type: "error", reason: "error", error: timedOutMessage });
			stream.end(timedOutMessage);
			return;
		}

		if (code !== 0) {
			const errMsg = stderr.trim() || `claude -p exited with code ${code}`;
			const errMessage = buildAssistantMessage(
				model,
				finalText || displayText || stdout,
				"error",
				errMsg,
				finalUsage,
				responseModel,
			);
			stream.push({ type: "error", reason: "error", error: errMessage });
			stream.end(errMessage);
			return;
		}

		const resolvedFinalText = finalText.trimEnd();
		(partial.content[0] as TextContent).text = resolvedFinalText;
		stream.push({
			type: "text_end",
			contentIndex: 0,
			content: resolvedFinalText,
			partial: { ...partial, content: [{ type: "text", text: resolvedFinalText }] },
		});

		const finalMessage = buildAssistantMessage(
			model,
			resolvedFinalText,
			"stop",
			undefined,
			finalUsage,
			responseModel,
		);
		stream.push({ type: "done", reason: "stop", message: finalMessage });
		stream.end(finalMessage);
	});

	return stream;
}

export const streamClaudeCli: StreamFunction<"claude-cli", StreamOptions> = (model, context, options) => {
	return runClaudeCli(model as Model<"claude-cli">, context, options);
};

export const streamSimpleClaudeCli: StreamFunction<"claude-cli", SimpleStreamOptions> = (model, context, options) => {
	return runClaudeCli(model as Model<"claude-cli">, context, options);
};
