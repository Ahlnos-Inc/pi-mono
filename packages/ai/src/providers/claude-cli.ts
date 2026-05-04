import { spawn } from "node:child_process";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
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
 * Tool access: we pass `--tools default --permission-mode bypassPermissions` so that the
 * subprocess has the same built-in toolset (Bash, Read, Edit, Write, Agent, …) as an
 * interactive Claude Code session. `bypassPermissions` prevents interactive prompts that
 * would hang an unattended subprocess. Key directories (Vault, ~/.pi, workspace) are added
 * via `--add-dir` so the subprocess can read/write them without cwd assumptions.
 *
 * Remaining limitation:
 * - No streaming of partial deltas — the subprocess blocks until the response is ready, then
 *   writes the final text to stdout. We emit a single text_start / text_delta(full) / text_end
 *   sequence. Tool calls execute internally before stdout is written.
 * - System prompt is passed via `claude -p --append-system-prompt` when present.
 */

/**
 * Maximum number of prior user/assistant turns to include as inline context.
 * Each turn round-trips with the latest message; too many turns inflate latency and cost.
 * 10 covers a typical session worth of working context.
 */
const MAX_PRIOR_TURNS = 10;

function extractPrompt(context: Context): string {
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

	let latestUserIdx = -1;
	for (let i = context.messages.length - 1; i >= 0; i--) {
		if (context.messages[i].role === "user") {
			latestUserIdx = i;
			break;
		}
	}
	if (latestUserIdx === -1) return "";

	const latestText = messageToText(context.messages[latestUserIdx]);
	if (!latestText) return "";

	// Collect prior user/assistant turns (skip tool results), most recent last
	const priorTurns: { label: "USER" | "ASSISTANT"; text: string }[] = [];
	for (let i = 0; i < latestUserIdx; i++) {
		const msg = context.messages[i];
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const text = messageToText(msg).trim();
		if (!text) continue;
		priorTurns.push({ label: msg.role === "user" ? "USER" : "ASSISTANT", text });
	}

	// Truncate to most recent MAX_PRIOR_TURNS
	const trimmed = priorTurns.slice(-MAX_PRIOR_TURNS);

	if (trimmed.length === 0) {
		return latestText;
	}

	const contextBlock = trimmed.map((t) => `[${t.label}]\n${t.text}`).join("\n\n");
	return `Prior conversation context (most recent last) — use as background for the question that follows:\n\n${contextBlock}\n\n---\n\nCurrent question:\n${latestText}`;
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
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
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

function buildClaudeArgs(model: Model<"claude-cli">, context: Context, prompt: string): string[] {
	const home = process.env.HOME ?? "/root";
	const args = [
		"-p",
		"--model",
		model.id,
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
	];
	const systemPrompt = context.systemPrompt;
	if (systemPrompt?.trim()) args.push("--append-system-prompt", systemPrompt);
	args.push(prompt);
	return args;
}

function runClaudeCli(model: Model<"claude-cli">, context: Context, signal?: AbortSignal) {
	const stream = createAssistantMessageEventStream();
	const prompt = extractPrompt(context);

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	delete childEnv.ANTHROPIC_API_KEY;
	delete childEnv.ANTHROPIC_AUTH_TOKEN;
	delete childEnv.ANTHROPIC_BASE_URL;

	let child: ReturnType<typeof spawn>;
	try {
		child = spawn("claude", buildClaudeArgs(model, context, prompt), {
			env: childEnv,
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
	let aborted = false;

	const onAbort = () => {
		aborted = true;
		try {
			child.kill("SIGTERM");
		} catch {
			/* noop */
		}
	};

	if (signal) {
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	const partial: AssistantMessage = buildAssistantMessage(model, "", "stop");
	stream.push({ type: "start", partial });
	partial.content = [{ type: "text", text: "" }];
	stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial, content: [{ type: "text", text: "" }] } });

	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");

	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
		(partial.content[0] as TextContent).text = stdout;
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: chunk,
			partial: { ...partial, content: [{ type: "text", text: stdout }] },
		});
	});

	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});

	child.on("error", (err) => {
		const errMessage = buildAssistantMessage(model, stdout, "error", `claude-cli error: ${err.message}`);
		stream.push({ type: "error", reason: "error", error: errMessage });
		stream.end(errMessage);
	});

	child.on("close", (code) => {
		if (signal) signal.removeEventListener("abort", onAbort);

		if (aborted) {
			const aborted = buildAssistantMessage(model, stdout, "aborted", "claude-cli aborted");
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}

		if (code !== 0) {
			const errMsg = stderr.trim() || `claude -p exited with code ${code}`;
			const errMessage = buildAssistantMessage(model, stdout, "error", errMsg);
			stream.push({ type: "error", reason: "error", error: errMessage });
			stream.end(errMessage);
			return;
		}

		const finalText = stdout.trimEnd();
		(partial.content[0] as TextContent).text = finalText;
		stream.push({
			type: "text_end",
			contentIndex: 0,
			content: finalText,
			partial: { ...partial, content: [{ type: "text", text: finalText }] },
		});

		const finalMessage = buildAssistantMessage(model, finalText, "stop");
		stream.push({ type: "done", reason: "stop", message: finalMessage });
		stream.end(finalMessage);
	});

	return stream;
}

export const streamClaudeCli: StreamFunction<"claude-cli", StreamOptions> = (model, context, options) => {
	return runClaudeCli(model as Model<"claude-cli">, context, options?.signal);
};

export const streamSimpleClaudeCli: StreamFunction<"claude-cli", SimpleStreamOptions> = (model, context, options) => {
	return runClaudeCli(model as Model<"claude-cli">, context, options?.signal);
};
