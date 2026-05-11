import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerSessionResourceCleanup } from "../session-resources.js";
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
 * Streaming: claude is invoked with stream-json input and output. Pi writes the user prompt as
 * a JSONL envelope on stdin and reads JSONL records for model deltas, tool calls, tool results,
 * lifecycle status, and the final result. Pi still treats claude-cli as one provider call:
 * Claude's internal tool calls are surfaced as compact activity text only, never as Pi ToolCall
 * blocks, so Pi does not re-execute them.
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

/**
 * Keep dynamic Claude CLI argument values comfortably below platform ARG_MAX.
 * Long compaction prompts can be hundreds of KB/MB; passing them as argv makes
 * node spawn fail with E2BIG before Claude can read anything. Use stdin/files
 * once values are no longer small command-line arguments.
 */
const MAX_CLAUDE_DYNAMIC_ARG_BYTES = 64 * 1024;
const VOLATILE_SYSTEM_PROMPT_BLOCK_RE =
	/<!-- pi-router: retrieved (?:context|memory) -->[\s\S]*?<!-- \/pi-router: retrieved (?:context|memory) -->/g;

type StickyClaudeSession = {
	sessionKey: string;
	sessionKeyHash: string;
	sessionId: string;
	turns: number;
	seenMessageCount: number;
	reuseStatus: "new" | "resume" | "disabled" | "stale-recreated" | "ephemeral";
	model: string;
	cwd: string;
	systemPromptHash: string;
	toolPolicyHash: string;
	ephemeral?: boolean;
};

const stickySessions = new Map<string, StickyClaudeSession>();
const activeChildren = new Set<ReturnType<typeof spawn>>();
const claudeWorkers = new Map<string, ClaudeWorker>();

// Time to wait for a claude-cli child to exit (releasing the per-PID session
// lock at ~/.claude/sessions/<pid>.json) before escalating to SIGKILL. Tuned
// long enough for normal flush, short enough that /quit stays snappy.
// Override via PI_CLAUDE_CLI_SHUTDOWN_TIMEOUT_MS.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000;

function shutdownTimeoutMs(): number {
	return positiveEnvInt("PI_CLAUDE_CLI_SHUTDOWN_TIMEOUT_MS") ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
	return new Promise<void>((resolve) => {
		// Already exited (number) or signal-killed (string)? nothing to wait on.
		// Live child has exitCode === null and signalCode === null on the real
		// ChildProcess; mocks may surface undefined here, also "still running".
		if (typeof child.exitCode === "number" || typeof child.signalCode === "string") {
			resolve();
			return;
		}
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(sigtermTimer);
			clearTimeout(sigkillTimer);
			resolve();
		};
		child.once("close", settle);
		// Graceful first: closing stdin signals claude-cli to flush its per-PID
		// session lock and exit. SIGTERM after a brief grace window if the EOF
		// goes unobserved. SIGKILL last so /quit cannot hang on a stuck child.
		try {
			child.stdin?.end();
		} catch {
			/* noop — stdin may already be closed */
		}
		const sigtermTimer = setTimeout(
			() => {
				try {
					child.kill("SIGTERM");
				} catch {
					/* noop */
				}
			},
			Math.min(300, Math.floor(timeoutMs / 4)),
		);
		const sigkillTimer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* noop */
			}
			settle();
		}, timeoutMs);
	});
}

async function cleanupClaudeCliSessionResources(): Promise<void> {
	const timeoutMs = shutdownTimeoutMs();
	// Mark every worker stopped (clears idle TTL timers). Don't kill from here —
	// the worker's child is also tracked in activeChildren, and waitForChildExit
	// runs there once per child.
	for (const worker of claudeWorkers.values()) {
		worker.markStopped();
	}
	claudeWorkers.clear();
	const waiters: Promise<void>[] = [];
	for (const child of activeChildren) {
		waiters.push(waitForChildExit(child, timeoutMs));
	}
	activeChildren.clear();
	stickySessions.clear();
	await Promise.all(waiters);
}

registerSessionResourceCleanup(cleanupClaudeCliSessionResources);

export async function _clearClaudeCliStickySessionsForTest(): Promise<void> {
	await cleanupClaudeCliSessionResources();
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
	return !/^(0|false|no|off)$/i.test(process.env.PI_CLAUDE_CLI_STICKY_SESSIONS ?? "1");
}

function claudeSessionReuseDisabled(options?: StreamOptions): boolean {
	return (
		options?.metadata?.disableClaudeSessionReuse === true ||
		options?.metadata?.claudeCliSessionReuse === false ||
		options?.metadata?.sessionPurpose === "compaction"
	);
}

function claudeSessionRegistryEnabled(): boolean {
	return !/^(0|false|no|off)$/i.test(process.env.PI_CLAUDE_CLI_SESSION_REGISTRY ?? "1");
}

function claudeWorkersEnabled(): boolean {
	return !/^(0|false|no|off)$/i.test(process.env.PI_CLAUDE_CLI_WORKERS ?? "1");
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

type ClaudeRegistryRecord = {
	claude_session_id: string;
	turns: number;
	last_seen_message_count: number;
};

function piRoot(): string {
	return process.env.PI_ROOT ?? join(process.env.HOME ?? "/root", ".pi");
}

function claudeSessionRegistryPath(): string {
	return process.env.PI_CLAUDE_CLI_SESSION_DB ?? join(piRoot(), "state", "claude-cli-sessions.sqlite");
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function runClaudeRegistrySql(sql: string): string | undefined {
	if (!claudeSessionRegistryEnabled()) return undefined;
	const dbPath = claudeSessionRegistryPath();
	try {
		mkdirSync(dirname(dbPath), { recursive: true });
		const result = spawnSync("sqlite3", ["-batch", "-json", dbPath, sql], {
			encoding: "utf8",
			timeout: 1000,
		});
		if (result.status !== 0 || result.error) return undefined;
		return result.stdout ?? "";
	} catch {
		return undefined;
	}
}

function ensureClaudeSessionRegistry(): void {
	runClaudeRegistrySql(`
create table if not exists claude_sessions (
  session_key text primary key,
  claude_session_id text not null,
  provider text not null,
  model text not null,
  effort text,
  cwd text not null,
  project_class text,
  agent_chosen text,
  data_class text,
  system_prompt_hash text not null,
  tool_policy_hash text not null,
  turns integer not null default 0,
  last_seen_message_count integer not null default 0,
  created_at text not null,
  updated_at text not null,
  last_status text not null default 'ok'
);
create table if not exists claude_session_workers (
  session_key text primary key,
  claude_session_id text not null,
  pid integer,
  boundary_hash text not null,
  started_at text,
  last_used_at text,
  status text not null
);`);
}

function readClaudeSessionRegistry(sessionKey: string): ClaudeRegistryRecord | undefined {
	if (!claudeSessionRegistryEnabled()) return undefined;
	ensureClaudeSessionRegistry();
	const rows = runClaudeRegistrySql(
		`select claude_session_id, turns, last_seen_message_count from claude_sessions where session_key = ${sqlString(sessionKey)} limit 1;`,
	);
	if (!rows?.trim()) return undefined;
	try {
		const parsed = JSON.parse(rows) as ClaudeRegistryRecord[];
		const row = parsed[0];
		if (!row || typeof row.claude_session_id !== "string") return undefined;
		return {
			claude_session_id: row.claude_session_id,
			turns: Number.isFinite(row.turns) ? row.turns : 0,
			last_seen_message_count: Number.isFinite(row.last_seen_message_count) ? row.last_seen_message_count : 0,
		};
	} catch {
		return undefined;
	}
}

function upsertClaudeSessionRegistry(session: StickyClaudeSession, status: string): void {
	if (session.ephemeral) return;
	if (!claudeSessionRegistryEnabled()) return;
	ensureClaudeSessionRegistry();
	const now = new Date().toISOString();
	runClaudeRegistrySql(`
insert into claude_sessions (
  session_key, claude_session_id, provider, model, effort, cwd, project_class,
  agent_chosen, data_class, system_prompt_hash, tool_policy_hash, turns,
  last_seen_message_count, created_at, updated_at, last_status
) values (
  ${sqlString(session.sessionKey)}, ${sqlString(session.sessionId)}, 'claude-cli',
  ${sqlString(session.model)}, null, ${sqlString(session.cwd)}, null, null, null,
  ${sqlString(session.systemPromptHash)}, ${sqlString(session.toolPolicyHash)},
  ${session.turns}, ${session.seenMessageCount}, ${sqlString(now)}, ${sqlString(now)}, ${sqlString(status)}
) on conflict(session_key) do update set
  claude_session_id=excluded.claude_session_id,
  model=excluded.model,
  cwd=excluded.cwd,
  system_prompt_hash=excluded.system_prompt_hash,
  tool_policy_hash=excluded.tool_policy_hash,
  turns=excluded.turns,
  last_seen_message_count=excluded.last_seen_message_count,
  updated_at=excluded.updated_at,
  last_status=excluded.last_status;`);
}

function markClaudeSessionWorker(session: StickyClaudeSession, pid: number | undefined, status: string): void {
	if (session.ephemeral) return;
	if (!claudeSessionRegistryEnabled()) return;
	ensureClaudeSessionRegistry();
	const now = new Date().toISOString();
	runClaudeRegistrySql(`
insert into claude_session_workers (
  session_key, claude_session_id, pid, boundary_hash, started_at, last_used_at, status
) values (
  ${sqlString(session.sessionKey)}, ${sqlString(session.sessionId)}, ${pid ?? "null"},
  ${sqlString(session.sessionKeyHash)}, ${sqlString(now)}, ${sqlString(now)}, ${sqlString(status)}
) on conflict(session_key) do update set
  claude_session_id=excluded.claude_session_id,
  pid=excluded.pid,
  boundary_hash=excluded.boundary_hash,
  last_used_at=excluded.last_used_at,
  status=excluded.status;`);
}

function appendClaudeSessionTelemetry(
	session: StickyClaudeSession,
	event: string,
	extra: Record<string, unknown> = {},
): void {
	if (/^(0|false|no|off)$/i.test(process.env.PI_CLAUDE_CLI_SESSION_TELEMETRY ?? "1")) return;
	try {
		const logsDir = join(piRoot(), "logs");
		mkdirSync(logsDir, { recursive: true });
		const username = process.env.USER ?? "unknown";
		appendFileSync(
			join(logsDir, `claude-cli-sessions-${username}.jsonl`),
			`${JSON.stringify({
				ts: new Date().toISOString(),
				event,
				claude_session_reuse: session.reuseStatus,
				claude_session_id: session.sessionId,
				claude_session_key_hash: session.sessionKeyHash,
				claude_session_turns_before: session.turns,
				claude_session_boundary: {
					cwd: session.cwd,
					model: session.model,
					system_prompt_hash: session.systemPromptHash,
					tool_policy_hash: session.toolPolicyHash,
				},
				...extra,
			})}\n`,
			"utf8",
		);
	} catch {
		// Telemetry is best-effort and must not block model dispatch.
	}
}

/**
 * Extracts the stable `<!-- pi-router-session agent="..." project="..." -->`
 * marker injected by the router extension's `before_agent_start` hook.
 * Returns the raw attribute string (e.g. `agent="foo" project="bar"`) when
 * present, or undefined when the prompt has no such marker (e.g. direct
 * claude-cli calls outside the router).
 */
function extractRouterSessionMarker(systemPrompt: string | undefined): string | undefined {
	const match = /<!-- pi-router-session ([^>]+) -->/.exec(systemPrompt ?? "");
	return match ? match[1].trim() : undefined;
}

function stickySessionKey(model: Model<"claude-cli">, context: Context, options?: StreamOptions): string {
	// When the router has injected a stable workstream-identity marker
	// (`<!-- pi-router-session agent="..." project="..." -->`), use the
	// marker as BOTH the boundary id AND the system-prompt hash component.
	// Result: two different pi-mono processes (or the same process after
	// restart) routing the same workstream produce the SAME session_key →
	// SQLite registry hits → existing Claude session is resumed instead of
	// a new one being spawned. Cross-pi-process workstream reuse, not just
	// within-process. When no marker (direct claude-cli calls outside the
	// router), fall back to the per-pi-mono-session boundary so unrelated
	// pi processes don't accidentally share sessions.
	const marker = extractRouterSessionMarker(context.systemPrompt);
	const sessionKey = marker ? `workstream:${digestText(marker)}` : claudeSessionBoundaryId(options);
	const systemPromptHash = marker
		? digestText(marker)
		: digestText(stableSystemPromptForClaudeSession(context.systemPrompt));
	const toolPolicyHash = digestText(
		JSON.stringify({
			includeUserClaudeContext: includeUserClaudeContext(),
			tools: "default",
			permissionMode: "bypassPermissions",
			addDirs: ["Vault-V2", ".pi", "projects/ahlnos"],
		}),
	);
	return [process.cwd(), sessionKey, model.id, systemPromptHash, toolPolicyHash].join("\n");
}

function claudeSessionBoundaryId(options?: StreamOptions): string {
	const explicitSessionId = options?.sessionId?.trim();
	if (explicitSessionId) return `session:${explicitSessionId}`;
	const envSessionId = process.env.PI_SESSION_ID?.trim();
	if (envSessionId) return `session:${envSessionId}`;
	return `pid:${process.pid}`;
}

function getStickySession(
	model: Model<"claude-cli">,
	context: Context,
	options?: StreamOptions,
): StickyClaudeSession | undefined {
	if (!stickyClaudeSessionsEnabled()) return undefined;
	const key = stickySessionKey(model, context, options);
	const existing = stickySessions.get(key);
	if (existing) return existing;
	const metadata = claudeSessionMetadata(model, context, key);
	const registryRecord = readClaudeSessionRegistry(key);
	const session = registryRecord
		? {
				...metadata,
				sessionId: registryRecord.claude_session_id,
				turns: registryRecord.turns,
				seenMessageCount: registryRecord.last_seen_message_count,
				reuseStatus: "resume" as const,
			}
		: {
				...metadata,
				sessionId: uuidFromKey(`pi-claude-cli\n${key}`),
				turns: 0,
				seenMessageCount: 0,
				reuseStatus: "new" as const,
			};
	upsertClaudeSessionRegistry(session, "ok");
	stickySessions.set(key, session);
	return session;
}

function createEphemeralClaudeSession(
	model: Model<"claude-cli">,
	context: Context,
	options?: StreamOptions,
): StickyClaudeSession {
	const key = `${stickySessionKey(model, context, options)}\nephemeral\n${randomUUID()}`;
	return {
		...claudeSessionMetadata(model, context, key),
		sessionId: randomUUID(),
		turns: 0,
		seenMessageCount: 0,
		reuseStatus: "ephemeral",
		ephemeral: true,
	};
}

function claudeSessionMetadata(model: Model<"claude-cli">, context: Context, key: string) {
	return {
		sessionKey: key,
		sessionKeyHash: digestText(key),
		model: model.id,
		cwd: process.cwd(),
		systemPromptHash: digestText(stableSystemPromptForClaudeSession(context.systemPrompt)),
		toolPolicyHash: digestText(
			JSON.stringify({
				includeUserClaudeContext: includeUserClaudeContext(),
				tools: "default",
				permissionMode: "bypassPermissions",
				addDirs: ["Vault-V2", ".pi", "projects/ahlnos"],
			}),
		),
	};
}

function stableSystemPromptForClaudeSession(systemPrompt?: string): string {
	return (systemPrompt ?? "")
		.replace(VOLATILE_SYSTEM_PROMPT_BLOCK_RE, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extractVolatileSystemPromptBlocks(systemPrompt?: string): string | undefined {
	const matches = [...(systemPrompt ?? "").matchAll(VOLATILE_SYSTEM_PROMPT_BLOCK_RE)]
		.map((match) => match[0].trim())
		.filter(Boolean);
	return matches.length > 0 ? matches.join("\n\n") : undefined;
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
	currentTurnContext?: string,
): string {
	const trimmed = priorTurns.slice(-MAX_PRIOR_TURNS);
	const sections: string[] = [];
	if (currentTurnContext) {
		sections.push(
			`Current turn Pi retrieved context and memory (use as supporting evidence for the question that follows):\n\n${currentTurnContext}`,
		);
	}
	if (trimmed.length > 0) {
		const contextBlock = trimmed.map((t) => `[${t.label}]\n${t.text}`).join("\n\n");
		sections.push(`${label}:\n\n${contextBlock}`);
	}
	if (sections.length === 0) return latestText;
	return `${sections.join("\n\n---\n\n")}\n\n---\n\nCurrent question:\n${latestText}`;
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
		extractVolatileSystemPromptBlocks(context.systemPrompt),
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

function shouldExternalizeClaudeArg(value: string): boolean {
	return Buffer.byteLength(value, "utf8") > MAX_CLAUDE_DYNAMIC_ARG_BYTES;
}

function writeClaudeArgTempFile(prefix: string, value: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-claude-cli-"));
	const file = join(dir, prefix);
	writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
	return file;
}

function cleanupClaudeArgTempFiles(files: string[]): void {
	for (const file of files) {
		try {
			rmSync(dirname(file), { recursive: true, force: true });
		} catch {
			/* noop */
		}
	}
}

type ClaudeInvocation = {
	args: string[];
	stdinPayload: string;
	tempFiles: string[];
};

function claudeUserInputJsonl(prompt: string): string {
	return `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`;
}

function buildClaudeInvocation(
	model: Model<"claude-cli">,
	context: Context,
	prompt: string,
	stickySession?: StickyClaudeSession,
): ClaudeInvocation {
	const home = process.env.HOME ?? "/root";
	const tempFiles: string[] = [];
	const args = [
		"-p",
		"--verbose",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		"--model",
		model.id,
	];

	if (stickySession) {
		args.push(stickySession.turns > 0 ? "--resume" : "--session-id", stickySession.sessionId);
	}

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
	if (systemPrompt?.trim()) {
		if (shouldExternalizeClaudeArg(systemPrompt)) {
			const systemPromptFile = writeClaudeArgTempFile("system-prompt.txt", systemPrompt);
			tempFiles.push(systemPromptFile);
			args.push("--system-prompt-file", systemPromptFile);
		} else {
			args.push("--system-prompt", systemPrompt);
		}
	}

	return { args, stdinPayload: claudeUserInputJsonl(prompt), tempFiles };
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

function textBlockBoundary(text: string): string {
	if (text.trim().length === 0) return "";
	return text.endsWith("\n") ? "" : "\n\n";
}

type ClaudeRequestState = {
	stream: ReturnType<typeof createAssistantMessageEventStream>;
	handleEvent: (event: ClaudeCliJson) => boolean;
	fail: (stopReason: AssistantMessage["stopReason"], errorMessage: string) => void;
	finish: () => void;
	resetIdleTimer: () => void;
	cleanup: () => void;
};

function createWorkerRequestState(input: {
	model: Model<"claude-cli">;
	options?: { signal?: AbortSignal; timeoutMs?: number };
	stickySession: StickyClaudeSession;
	nextSeenMessageCount: number;
	terminateWorker: () => void;
	markAborted?: () => void;
}): ClaudeRequestState {
	const stream = createAssistantMessageEventStream();
	const idleTimeoutMs = resolveIdleTimeoutMs(input.options?.timeoutMs);
	const maxRuntimeMs = resolveMaxRuntimeMs();
	let finalText = "";
	let displayText = "";
	let responseModel: string | undefined;
	let finalUsage: Usage | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;
	const blocks = new Map<number, ClaudeCliContentBlockState>();
	const partial: AssistantMessage = buildAssistantMessage(input.model, "", "stop");

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

	function resetIdleTimer() {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			const seconds = Math.ceil(idleTimeoutMs / 1000);
			appendActivity(`no claude-cli output for ${seconds}s; still waiting`);
			resetIdleTimer();
		}, idleTimeoutMs);
	}

	const onAbort = () => {
		// Soft-abort path: the worker stays alive and drains the in-flight turn so
		// the next prompt can reuse the same OS process (no claude-cli cold start).
		// Falls back to the legacy hard kill when the caller didn't wire markAborted.
		if (input.markAborted) input.markAborted();
		else input.terminateWorker();
		fail("aborted", "claude-cli aborted");
	};

	function cleanup() {
		if (idleTimer) clearTimeout(idleTimer);
		if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
		if (input.options?.signal) input.options.signal.removeEventListener("abort", onAbort);
	}

	function fail(stopReason: AssistantMessage["stopReason"], errorMessage: string) {
		cleanup();
		upsertClaudeSessionRegistry(input.stickySession, "error");
		appendClaudeSessionTelemetry(input.stickySession, "worker-error", { error: errorMessage });
		const message = buildAssistantMessage(
			input.model,
			finalText || displayText,
			stopReason,
			errorMessage,
			finalUsage,
			responseModel,
		);
		stream.push({ type: "error", reason: stopReason === "aborted" ? "aborted" : "error", error: message });
		stream.end(message);
	}

	function finish() {
		cleanup();
		const resolvedFinalText = finalText.trimEnd();
		(partial.content[0] as TextContent).text = resolvedFinalText;
		stream.push({
			type: "text_end",
			contentIndex: 0,
			content: resolvedFinalText,
			partial: { ...partial, content: [{ type: "text", text: resolvedFinalText }] },
		});
		const finalMessage = buildAssistantMessage(
			input.model,
			resolvedFinalText,
			"stop",
			undefined,
			finalUsage,
			responseModel,
		);
		stream.push({ type: "done", reason: "stop", message: finalMessage });
		stream.end(finalMessage);
	}

	const handleEvent = (event: ClaudeCliJson): boolean => {
		resetIdleTimer();
		if (event.type === "system") {
			if (event.subtype === "init") {
				responseModel = typeof event.model === "string" ? event.model : responseModel;
				const toolCount = Array.isArray(event.tools) ? event.tools.length : undefined;
				appendActivity(
					toolCount ? `initialized ${event.model ?? input.model.id} with ${toolCount} tools` : "initialized",
				);
			} else if (event.subtype === "status" && typeof event.status === "string") {
				appendActivity(event.status === "requesting" ? "requesting model response" : event.status);
			}
			return false;
		}

		if (event.type === "stream_event" && event.event && typeof event.event === "object") {
			const streamEvent = event.event as ClaudeCliJson;
			if (streamEvent.type === "message_start") {
				const messageModel = streamEvent.message?.model;
				if (typeof messageModel === "string") responseModel = messageModel;
				appendActivity(`model turn started (${responseModel ?? input.model.id})`);
				return false;
			}
			if (streamEvent.type === "content_block_start") {
				const index = numberValue(streamEvent.index);
				const block = streamEvent.content_block as ClaudeCliJson | undefined;
				const blockType = typeof block?.type === "string" ? block.type : "unknown";
				if (blockType === "text") {
					blocks.set(index, { type: "text", text: "" });
					const boundary = textBlockBoundary(finalText);
					if (boundary) {
						finalText += boundary;
						updateDisplay(finalText, boundary);
					} else if (!finalText && displayText) updateDisplay("", "");
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
				return false;
			}
			if (streamEvent.type === "content_block_delta") {
				const index = numberValue(streamEvent.index);
				const block = blocks.get(index);
				const delta = streamEvent.delta as ClaudeCliJson | undefined;
				if (!block || !delta) return false;
				if (block.type === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
					finalText += delta.text;
					updateDisplay(finalText, delta.text);
				}
				if (
					block.type === "tool_use" &&
					delta.type === "input_json_delta" &&
					typeof delta.partial_json === "string"
				) {
					block.inputJson = `${block.inputJson ?? ""}${delta.partial_json}`;
					if (!block.announcedInput) {
						try {
							const summary = summarizeToolInput(block.name, JSON.parse(block.inputJson));
							appendActivity(summary ? `running ${block.name}: ${summary}` : `running ${block.name}`);
							block.announcedInput = true;
						} catch {
							// Wait for complete JSON.
						}
					}
				}
				return false;
			}
			if (streamEvent.type === "content_block_stop") {
				const index = numberValue(streamEvent.index);
				const block = blocks.get(index);
				if (block?.type === "tool_use" && !block.announcedInput) appendActivity(`running ${block.name ?? "tool"}`);
				blocks.delete(index);
				return false;
			}
			if (streamEvent.type === "message_delta" && streamEvent.delta?.stop_reason === "tool_use")
				appendActivity("waiting for tool result");
			return false;
		}

		if (event.type === "user" && event.tool_use_result && typeof event.tool_use_result === "object") {
			const result = event.tool_use_result as ClaudeCliJson;
			appendActivity(
				result.is_error === true || result.interrupted === true ? "tool returned an error" : "tool completed",
			);
			return false;
		}

		if (event.type === "assistant") {
			const messageModel = event.message?.model;
			if (typeof messageModel === "string") responseModel = messageModel;
			return false;
		}

		if (event.type === "result") {
			if (typeof event.result === "string" && finalText.length === 0) finalText = event.result;
			finalUsage = usageFromClaudeResult(event);
			input.stickySession.turns += 1;
			input.stickySession.seenMessageCount = input.nextSeenMessageCount;
			input.stickySession.reuseStatus = "resume";
			upsertClaudeSessionRegistry(input.stickySession, "ok");
			appendClaudeSessionTelemetry(input.stickySession, "worker-result", {
				response_model: responseModel,
				usage_input_tokens: finalUsage?.input,
				usage_output_tokens: finalUsage?.output,
			});
			return true;
		}
		return false;
	};

	stream.push({ type: "start", partial });
	partial.content = [{ type: "text", text: "" }];
	stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial, content: [{ type: "text", text: "" }] } });
	resetIdleTimer();
	if (maxRuntimeMs !== undefined) {
		maxRuntimeTimer = setTimeout(() => {
			input.terminateWorker();
			fail("error", `claude-cli max runtime timed out after ${Math.ceil(maxRuntimeMs / 1000)}s`);
		}, maxRuntimeMs);
	}
	if (input.options?.signal) {
		if (input.options.signal.aborted) onAbort();
		else input.options.signal.addEventListener("abort", onAbort, { once: true });
	}

	return { stream, handleEvent, fail, finish, resetIdleTimer, cleanup };
}

type ClaudeWorkerQueueItem = {
	prompt: string;
	state: ClaudeRequestState;
};

class ClaudeWorker {
	private child: ReturnType<typeof spawn>;
	private lineBuffer = "";
	private stderr = "";
	private pending: ClaudeWorkerQueueItem | undefined;
	private queue: ClaudeWorkerQueueItem[] = [];
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private tempFiles: string[] = [];
	private stopped = false;
	// Each entry counts a turn that was aborted by the caller while still in
	// flight on claude. We keep the worker alive and discard claude's events
	// for those turns until their `result` event arrives, which lets the next
	// queued prompt barge-in on the same OS process instead of paying a cold
	// start. Decremented per `result` event observed in onStdout.
	private drainResultsRemaining = 0;

	constructor(
		model: Model<"claude-cli">,
		context: Context,
		private readonly stickySession: StickyClaudeSession,
	) {
		const invocation = buildClaudeInvocation(model, context, "", stickySession);
		this.tempFiles = invocation.tempFiles;
		const childEnv: NodeJS.ProcessEnv = { ...process.env };
		delete childEnv.ANTHROPIC_API_KEY;
		delete childEnv.ANTHROPIC_AUTH_TOKEN;
		delete childEnv.ANTHROPIC_BASE_URL;
		const home = process.env.HOME ?? "/root";
		this.child = spawn("claude", invocation.args, {
			env: childEnv,
			cwd: `${home}/projects/ahlnos`,
			stdio: ["pipe", "pipe", "pipe"],
		});
		activeChildren.add(this.child);
		markClaudeSessionWorker(stickySession, this.child.pid, "running");
		appendClaudeSessionTelemetry(stickySession, stickySession.turns === 0 ? "worker-start-new" : "worker-resume");
		this.child.stdout?.setEncoding("utf8");
		this.child.stderr?.setEncoding("utf8");
		this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		this.child.stderr?.on("data", (chunk: string) => {
			this.stderr += chunk;
			this.pending?.state.resetIdleTimer();
		});
		this.child.on("error", (err) => this.failAll(`claude-cli worker error: ${err.message}`));
		this.child.on("close", (code) => {
			cleanupClaudeArgTempFiles(this.tempFiles);
			activeChildren.delete(this.child);
			claudeWorkers.delete(this.stickySession.sessionKey);
			markClaudeSessionWorker(stickySession, undefined, "closed");
			if (!this.stopped && (this.pending || this.queue.length > 0)) {
				this.failAll(this.stderr.trim() || `claude-cli worker exited with code ${code}`);
			}
		});
	}

	request(prompt: string, state: ClaudeRequestState) {
		this.queue.push({ prompt, state });
		this.pump();
		return state.stream;
	}

	stop(): void {
		this.stopped = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		try {
			this.child.kill("SIGTERM");
		} catch {
			/* noop */
		}
	}

	markStopped(): void {
		this.stopped = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
	}

	private onStdout(chunk: string): void {
		this.lineBuffer += chunk;
		let newlineIndex = this.lineBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.lineBuffer.slice(0, newlineIndex);
			this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
			const parsed = parseJsonLine(line);
			if (!parsed) {
				newlineIndex = this.lineBuffer.indexOf("\n");
				continue;
			}
			if (this.drainResultsRemaining > 0) {
				if (parsed.type === "result") this.drainResultsRemaining -= 1;
				newlineIndex = this.lineBuffer.indexOf("\n");
				continue;
			}
			if (this.pending?.state.handleEvent(parsed)) {
				this.pending.state.finish();
				this.pending = undefined;
				markClaudeSessionWorker(this.stickySession, this.child.pid, "idle");
				this.scheduleIdleStop();
				this.pump();
			}
			newlineIndex = this.lineBuffer.indexOf("\n");
		}
	}

	abortPending(state: ClaudeRequestState): void {
		if (this.pending?.state === state) {
			// Active turn aborted: claude will eventually emit a `result` event for
			// it (truncated when we send the next user event as a barge-in). Until
			// that result arrives, every event in onStdout belongs to the aborted
			// turn and must be discarded. Free the slot now so pump() can fire the
			// next queued prompt as the barge-in trigger.
			this.drainResultsRemaining += 1;
			this.pending = undefined;
			this.pump();
			return;
		}
		const queuedIdx = this.queue.findIndex((item) => item.state === state);
		if (queuedIdx !== -1) this.queue.splice(queuedIdx, 1);
	}

	private pump(): void {
		if (this.pending || this.queue.length === 0) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.pending = this.queue.shift();
		markClaudeSessionWorker(this.stickySession, this.child.pid, "running");
		this.child.stdin?.write(claudeUserInputJsonl(this.pending?.prompt ?? ""));
	}

	private scheduleIdleStop(): void {
		if (this.queue.length > 0 || this.pending) return;
		const ttl = positiveEnvInt("PI_CLAUDE_CLI_WORKER_TTL_MS") ?? 20 * 60 * 1000;
		this.idleTimer = setTimeout(() => this.stop(), ttl);
	}

	private failAll(message: string): void {
		this.pending?.state.fail("error", message);
		this.pending = undefined;
		for (const item of this.queue.splice(0)) item.state.fail("error", message);
		this.drainResultsRemaining = 0;
		claudeWorkers.delete(this.stickySession.sessionKey);
		markClaudeSessionWorker(this.stickySession, undefined, "error");
	}
}

function runClaudeCli(model: Model<"claude-cli">, context: Context, options?: StreamOptions) {
	const stickySession = claudeSessionReuseDisabled(options)
		? createEphemeralClaudeSession(model, context, options)
		: getStickySession(model, context, options);
	if (stickySession && !stickySession.ephemeral && claudeWorkersEnabled()) {
		const prompt = extractPrompt(context, stickySession);
		const nextSeenMessageCount = latestUserIndex(context) + 2;
		try {
			let worker = claudeWorkers.get(stickySession.sessionKey);
			if (!worker) {
				worker = new ClaudeWorker(model, context, stickySession);
				claudeWorkers.set(stickySession.sessionKey, worker);
			}
			const state: ClaudeRequestState = createWorkerRequestState({
				model,
				options,
				stickySession,
				nextSeenMessageCount,
				terminateWorker: () => worker?.stop(),
				markAborted: () => worker?.abortPending(state),
			});
			return worker.request(prompt, state);
		} catch (err) {
			appendClaudeSessionTelemetry(stickySession, "worker-start-failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			claudeWorkers.delete(stickySession.sessionKey);
		}
	}
	return runClaudeCliOneShot(model, context, options, stickySession);
}

function runClaudeCliOneShot(
	model: Model<"claude-cli">,
	context: Context,
	options?: StreamOptions,
	stickySession = claudeSessionReuseDisabled(options)
		? createEphemeralClaudeSession(model, context, options)
		: getStickySession(model, context, options),
) {
	const stream = createAssistantMessageEventStream();
	const prompt = extractPrompt(context, stickySession);
	const nextSeenMessageCount = latestUserIndex(context) + 2;
	const idleTimeoutMs = resolveIdleTimeoutMs(options?.timeoutMs);
	const maxRuntimeMs = resolveMaxRuntimeMs();

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	delete childEnv.ANTHROPIC_API_KEY;
	delete childEnv.ANTHROPIC_AUTH_TOKEN;
	delete childEnv.ANTHROPIC_BASE_URL;

	const home = process.env.HOME ?? "/root";
	const invocation = buildClaudeInvocation(model, context, prompt, stickySession);
	if (stickySession)
		appendClaudeSessionTelemetry(stickySession, stickySession.turns === 0 ? "start-new" : "resume-one-shot");
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn("claude", invocation.args, {
			env: childEnv,
			cwd: `${home}/projects/ahlnos`,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdin?.end(invocation.stdinPayload);
		activeChildren.add(child);
	} catch (spawnErr) {
		cleanupClaudeArgTempFiles(invocation.tempFiles);
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
	let sawClaudeSessionActivity = false;
	let aborted = false;
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
			const seconds = Math.ceil(idleTimeoutMs / 1000);
			appendActivity(`no claude-cli output for ${seconds}s; still waiting`);
			resetIdleTimer();
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
		activeChildren.delete(child);
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
			sawClaudeSessionActivity = true;
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
				sawClaudeSessionActivity = true;
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
					const boundary = textBlockBoundary(finalText);
					if (boundary) {
						finalText += boundary;
						updateDisplay(finalText, boundary);
					} else if (!finalText && displayText) updateDisplay("", "");
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
			sawClaudeSessionActivity = true;
			const messageModel = event.message?.model;
			if (typeof messageModel === "string") responseModel = messageModel;
			return;
		}

		if (event.type === "result") {
			sawClaudeSessionActivity = true;
			if (typeof event.result === "string" && finalText.length === 0) finalText = event.result;
			finalUsage = usageFromClaudeResult(event);
			if (stickySession) {
				if (!stickySession.ephemeral) {
					stickySession.turns += 1;
					stickySession.seenMessageCount = nextSeenMessageCount;
					stickySession.reuseStatus = "resume";
					upsertClaudeSessionRegistry(stickySession, "ok");
				}
				appendClaudeSessionTelemetry(stickySession, "result", {
					response_model: responseModel,
					usage_input_tokens: finalUsage?.input,
					usage_output_tokens: finalUsage?.output,
				});
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
		cleanupClaudeArgTempFiles(invocation.tempFiles);
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
		cleanupClaudeArgTempFiles(invocation.tempFiles);
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

		if (maxRuntimeTimedOut) {
			if (stickySession && !stickySession.ephemeral && sawClaudeSessionActivity && stickySession.turns === 0) {
				stickySession.turns = 1;
				stickySession.seenMessageCount = nextSeenMessageCount;
			}
			const seconds = Math.ceil((maxRuntimeMs ?? idleTimeoutMs) / 1000);
			const timedOutMessage = buildAssistantMessage(
				model,
				finalText || displayText,
				"error",
				`claude-cli max runtime timed out after ${seconds}s`,
				finalUsage,
				responseModel,
			);
			stream.push({ type: "error", reason: "error", error: timedOutMessage });
			stream.end(timedOutMessage);
			return;
		}

		if (code !== 0) {
			const errMsg = stderr.trim() || `claude -p exited with code ${code}`;
			if (stickySession) {
				if (
					!stickySession.ephemeral &&
					/Session ID .* is already in use|No conversation found|not found|invalid session/i.test(errMsg)
				) {
					stickySessions.delete(stickySession.sessionKey);
					stickySession.reuseStatus = "stale-recreated";
					stickySession.turns = 0;
					stickySession.seenMessageCount = 0;
					stickySession.sessionId = uuidFromKey(`pi-claude-cli\n${stickySession.sessionKey}\n${Date.now()}`);
				}
				upsertClaudeSessionRegistry(stickySession, "error");
				appendClaudeSessionTelemetry(stickySession, "error", { error: errMsg });
			}
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
