import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _clearClaudeCliStickySessionsForTest, streamClaudeCli } from "../src/providers/claude-cli.js";
import type { AssistantMessageEvent, Context, Message, Model } from "../src/types.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

class MockChildProcess extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdinPayload = "";
	kill = vi.fn();

	constructor() {
		super();
		const originalEnd = this.stdin.end.bind(this.stdin);
		const originalWrite = this.stdin.write.bind(this.stdin);
		this.stdin.write = ((chunk: any, ...args: any[]) => {
			if (chunk !== undefined && chunk !== null)
				this.stdinPayload += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			return originalWrite(chunk, ...args);
		}) as typeof this.stdin.write;
		this.stdin.end = ((chunk?: any, ...args: any[]) => {
			if (chunk !== undefined && chunk !== null)
				this.stdinPayload += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			return originalEnd(chunk, ...args);
		}) as typeof this.stdin.end;
	}
}

const model: Model<"claude-cli"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "claude-cli",
	provider: "anthropic",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
};

function context(systemPrompt?: string): Context {
	return {
		systemPrompt,
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
	};
}

function contextWithMessages(messages: Message[], systemPrompt?: string): Context {
	return { systemPrompt, messages };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function writeJsonl(child: MockChildProcess, events: unknown[]): void {
	for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
}

function userEnvelopePayload(child: MockChildProcess): string {
	return JSON.parse(child.stdinPayload).message.content;
}

function userEnvelopePayloads(child: MockChildProcess): string[] {
	return child.stdinPayload
		.trim()
		.split(/\n+/)
		.filter(Boolean)
		.map((line) => JSON.parse(line).message.content);
}

describe("claude-cli provider", () => {
	beforeEach(() => {
		vi.useRealTimers();
		delete process.env.PI_CLAUDE_CLI_INCLUDE_USER_CONTEXT;
		delete process.env.PI_CLAUDE_CLI_BRIEF;
		delete process.env.PI_CLAUDE_CLI_ACTIVITY_TEXT;
		delete process.env.PI_CLAUDE_CLI_VERBOSE_ACTIVITY;
		delete process.env.PI_CLAUDE_CLI_STICKY_SESSIONS;
		delete process.env.TMUX_PANE;
		delete process.env.PI_ROOT;
		delete process.env.PI_API_KEYS_ENV;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		delete process.env.PI_CLAUDE_AUTH_PROFILE;
		delete process.env.PI_CLAUDE_AUTH_FINGERPRINT;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		delete process.env.ANTHROPIC_BASE_URL;
		process.env.PI_CLAUDE_CLI_WORKERS = "0";
		process.env.PI_CLAUDE_CLI_SESSION_REGISTRY = "0";
		process.env.PI_CLAUDE_CLI_SESSION_TELEMETRY = "0";
		delete process.env.PI_CLAUDE_CLI_MAX_RUNTIME_MS;
		_clearClaudeCliStickySessionsForTest();
		spawnMock.mockReset();
		spawnMock.mockImplementation(() => new MockChildProcess());
	});

	it("spawns claude with core tools and scoped settings by default", () => {
		const child = new MockChildProcess();
		spawnMock.mockReturnValueOnce(child);
		streamClaudeCli(model, context(), {});

		expect(spawnMock).toHaveBeenCalledWith(
			"claude",
			expect.arrayContaining([
				"-p",
				"--verbose",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--include-partial-messages",
				"--brief",
				"--model",
				model.id,
				"--setting-sources",
				"local",
				"--strict-mcp-config",
				"--mcp-config",
				'{"mcpServers":{}}',
				"--tools",
				"default",
				"--permission-mode",
				"bypassPermissions",
				"--add-dir",
			]),
			{
				env: expect.any(Object),
				cwd: `${process.env.HOME ?? "/root"}/projects/ahlnos`,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		expect(spawnMock.mock.calls[0][1]).not.toContain("hello");
		expect(child.stdinPayload).toBe(
			`${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
		);
		expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("shell");
	});

	it("scrubs Anthropic API env and applies the active Pi Claude auth profile", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-claude-auth-provider-"));
		try {
			mkdirSync(join(root, "state"), { recursive: true });
			writeFileSync(join(root, "state", "api-keys.env"), 'CLAUDE_CODE_OAUTH_TOKEN_NICHOLAS="profile-token"\n');
			writeFileSync(
				join(root, "state", "claude-auth-active.json"),
				JSON.stringify({
					version: 1,
					mode: "profile",
					profile: "nicholas",
					token_env_var: "CLAUDE_CODE_OAUTH_TOKEN_NICHOLAS",
					token_fingerprint: "sha256:old",
				}),
			);
			process.env.PI_ROOT = root;
			process.env.ANTHROPIC_API_KEY = "payg-key";
			process.env.ANTHROPIC_AUTH_TOKEN = "wrong-token";
			process.env.ANTHROPIC_BASE_URL = "https://example.invalid";

			streamClaudeCli(model, context(), {});

			const childEnv = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
			expect(childEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
			expect(childEnv).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
			expect(childEnv).not.toHaveProperty("ANTHROPIC_BASE_URL");
			expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("profile-token");
			expect(childEnv.PI_CLAUDE_AUTH_PROFILE).toBe("nicholas");
			expect(childEnv.PI_CLAUDE_AUTH_FINGERPRINT).toMatch(/^sha256:/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("can restore the full user Claude Code environment explicitly", () => {
		process.env.PI_CLAUDE_CLI_INCLUDE_USER_CONTEXT = "1";

		streamClaudeCli(model, context(), {});

		expect(spawnMock.mock.calls[0][1]).not.toContain("--setting-sources");
		expect(spawnMock.mock.calls[0][1]).not.toContain("--strict-mcp-config");
		expect(spawnMock.mock.calls[0][1]).toEqual(
			expect.arrayContaining(["--tools", "default", "--permission-mode", "bypassPermissions", "--add-dir"]),
		);
	});

	it("passes a non-empty system prompt via --system-prompt", () => {
		streamClaudeCli(model, context(" route instructions\n"), {});

		expect(spawnMock.mock.calls[0][1]).toEqual(expect.arrayContaining(["--system-prompt", " route instructions\n"]));
	});

	it("skips --system-prompt for whitespace-only system prompts", () => {
		streamClaudeCli(model, context(" \n\t "), {});

		expect(spawnMock.mock.calls[0][1]).not.toContain("--system-prompt");
		expect(spawnMock.mock.calls[0][1]).not.toContain("hello");
	});

	it("passes multiline shell-looking system prompts as one argv element", () => {
		const systemPrompt = "first line\nsecond '$HOME' `rm -rf /`; $(echo nope)";

		streamClaudeCli(model, context(systemPrompt), {});

		expect(spawnMock.mock.calls[0][1]).toEqual(expect.arrayContaining(["--system-prompt", systemPrompt]));
		expect(spawnMock.mock.calls[0][1]).not.toContain("hello");
		expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("shell");
	});

	it("passes all prompts through JSONL stdin instead of argv to avoid E2BIG", () => {
		const largePrompt = "x".repeat(70 * 1024);
		const child = new MockChildProcess();
		spawnMock.mockReturnValueOnce(child);

		streamClaudeCli(model, contextWithMessages([{ role: "user", content: largePrompt, timestamp: 1 }]), {});

		const args = spawnMock.mock.calls[0][1] as string[];
		expect(args).not.toContain(largePrompt);
		expect(spawnMock.mock.calls[0][2]).toMatchObject({ stdio: ["pipe", "pipe", "pipe"] });
		expect(userEnvelopePayload(child)).toBe(largePrompt);
	});

	it("passes large system prompts through a file instead of argv to avoid E2BIG", () => {
		const largeSystemPrompt = `system\n${"y".repeat(70 * 1024)}`;
		const child = new MockChildProcess();
		spawnMock.mockReturnValueOnce(child);

		streamClaudeCli(model, context(largeSystemPrompt), {});

		const args = spawnMock.mock.calls[0][1] as string[];
		const fileArgIndex = args.indexOf("--system-prompt-file");
		expect(fileArgIndex).toBeGreaterThanOrEqual(0);
		expect(args).not.toContain(largeSystemPrompt);
		expect(readFileSync(args[fileArgIndex + 1], "utf8")).toBe(largeSystemPrompt);

		child.emit("close", 0);
		expect(existsSync(args[fileArgIndex + 1])).toBe(false);
	});

	it("uses a sticky Claude session id across calls with the same system prompt", () => {
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";
		const firstChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(new MockChildProcess());

		streamClaudeCli(model, context("same system"), {});
		writeJsonl(firstChild, [{ type: "result", subtype: "success", result: "ok", usage: {} }]);
		streamClaudeCli(model, context("same system"), {});

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--resume") + 1];

		expect(firstSession).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(secondSession).toBe(firstSession);
	});

	it("can keep a long-lived worker for sequential same-boundary turns", async () => {
		process.env.PI_CLAUDE_CLI_WORKERS = "1";
		const child = new MockChildProcess();
		spawnMock.mockReturnValueOnce(child);

		const firstStream = streamClaudeCli(model, context("same system"), {});
		const firstEventsPromise = collectEvents(firstStream);
		writeJsonl(child, [{ type: "result", subtype: "success", result: "first", usage: {} }]);
		await firstEventsPromise;

		const secondMessages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "first" }], timestamp: 2 } as Message,
			{ role: "user", content: "again", timestamp: 3 },
		];
		const secondStream = streamClaudeCli(model, contextWithMessages(secondMessages, "same system"), {});
		const secondEventsPromise = collectEvents(secondStream);
		writeJsonl(child, [{ type: "result", subtype: "success", result: "second", usage: {} }]);
		const secondEvents = await secondEventsPromise;

		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(userEnvelopePayloads(child)).toEqual(["hello", "again"]);
		const done = secondEvents.find((event) => event.type === "done");
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("Expected done event");
		expect(done.message.content).toEqual([{ type: "text", text: "second" }]);
	});

	it("keeps a long-lived worker when only prompt-scoped Pi retrieval changes", async () => {
		process.env.PI_CLAUDE_CLI_WORKERS = "1";
		const child = new MockChildProcess();
		spawnMock.mockReturnValueOnce(child);
		const firstSystem = [
			"same stable system",
			"<!-- pi-router: retrieved context -->",
			"## Retrieved Context",
			"first prompt hit",
			"<!-- /pi-router: retrieved context -->",
		].join("\n");
		const secondSystem = [
			"same stable system",
			"<!-- pi-router: retrieved context -->",
			"## Retrieved Context",
			"second prompt hit",
			"<!-- /pi-router: retrieved context -->",
		].join("\n");

		const firstStream = streamClaudeCli(model, context(firstSystem), {});
		const firstEventsPromise = collectEvents(firstStream);
		writeJsonl(child, [{ type: "result", subtype: "success", result: "first", usage: {} }]);
		await firstEventsPromise;

		const secondMessages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "first" }], timestamp: 2 } as Message,
			{ role: "user", content: "again", timestamp: 3 },
		];
		const secondStream = streamClaudeCli(model, contextWithMessages(secondMessages, secondSystem), {});
		const secondEventsPromise = collectEvents(secondStream);
		writeJsonl(child, [{ type: "result", subtype: "success", result: "second", usage: {} }]);
		await secondEventsPromise;

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const payloads = userEnvelopePayloads(child);
		expect(payloads[0]).toBe("hello");
		expect(payloads[1]).toContain("Current turn Pi retrieved context and memory");
		expect(payloads[1]).toContain("second prompt hit");
		expect(payloads[1]).toContain("Current question:\nagain");
	});

	it("restarts an idle worker with append-system-prompt when agent context changes", async () => {
		process.env.PI_CLAUDE_CLI_WORKERS = "1";
		process.env.TMUX_PANE = "%7";
		const firstChild = new MockChildProcess();
		const secondChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

		const firstSystem = `<!-- pi-router-session agent="agency/engineering/engineering-backend-architect" project="pi-infra" -->\n\nbackend context`;
		const secondSystem = `<!-- pi-router-session agent="agency/engineering/engineering-devops-automator" project="pi-infra" -->\n\ndevops context`;

		const firstStream = streamClaudeCli(model, context(firstSystem), { sessionId: "window-uuid" });
		const firstEventsPromise = collectEvents(firstStream);
		writeJsonl(firstChild, [{ type: "result", subtype: "success", result: "first", usage: {} }]);
		await firstEventsPromise;

		const secondStream = streamClaudeCli(model, context(secondSystem), { sessionId: "window-uuid" });
		const secondEventsPromise = collectEvents(secondStream);
		await Promise.resolve();
		expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
		firstChild.emit("close", 0);
		await Promise.resolve();
		await Promise.resolve();
		writeJsonl(secondChild, [{ type: "result", subtype: "success", result: "second", usage: {} }]);
		const secondEvents = await secondEventsPromise;

		expect(spawnMock).toHaveBeenCalledTimes(2);
		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--resume") + 1];
		expect(secondSession).toBe(firstSession);
		expect(secondArgs).toContain("--append-system-prompt");
		expect(secondArgs).toContain(secondSystem);
		const done = secondEvents.find((event) => event.type === "done");
		expect(done?.type).toBe("done");
	});

	it("keeps the worker alive on abort and reuses it for the next prompt (barge-in)", async () => {
		process.env.PI_CLAUDE_CLI_WORKERS = "1";
		const child = new MockChildProcess();
		spawnMock.mockReturnValueOnce(child);

		const controller = new AbortController();
		const firstStream = streamClaudeCli(model, context("same system"), { signal: controller.signal });
		const firstEventsPromise = collectEvents(firstStream);
		// Abort the in-flight turn — the worker MUST stay alive (no kill).
		controller.abort();
		const firstEvents = await firstEventsPromise;

		expect(child.kill).not.toHaveBeenCalled();
		const firstError = firstEvents.find((event) => event.type === "error");
		expect(firstError?.type).toBe("error");

		// Next prompt must reuse the same worker (no second spawn).
		const secondMessages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "" }], timestamp: 2 } as Message,
			{ role: "user", content: "again", timestamp: 3 },
		];
		const secondStream = streamClaudeCli(model, contextWithMessages(secondMessages, "same system"), {});
		const secondEventsPromise = collectEvents(secondStream);
		// First the truncated `result` from the aborted turn arrives — it must be
		// drained and ignored. Then the new turn's `result` resolves cleanly.
		writeJsonl(child, [{ type: "result", subtype: "success", result: "discarded", usage: {} }]);
		writeJsonl(child, [{ type: "result", subtype: "success", result: "second", usage: {} }]);
		const secondEvents = await secondEventsPromise;

		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(child.kill).not.toHaveBeenCalled();
		const done = secondEvents.find((event) => event.type === "done");
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("Expected done event");
		expect(done.message.content).toEqual([{ type: "text", text: "second" }]);
		// Both prompts were sent to the same child stdin (barge-in delivered).
		expect(userEnvelopePayloads(child)).toEqual(["hello", expect.stringContaining("again")]);
	});

	it("only sends inline prior Pi turns on the first sticky Claude call", () => {
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";

		const child = new MockChildProcess();
		spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(new MockChildProcess());
		const firstMessages: Message[] = [{ role: "user", content: "first question", timestamp: 1 }];

		streamClaudeCli(model, contextWithMessages(firstMessages, "same system"), {});
		writeJsonl(child, [{ type: "result", subtype: "success", result: "ok", usage: {} }]);
		const secondMessages: Message[] = [
			{ role: "user", content: "first question", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 2 } as Message,
			{ role: "user", content: "follow-up", timestamp: 3 },
		];
		streamClaudeCli(model, contextWithMessages(secondMessages, "same system"), {});

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		expect(firstArgs).toEqual(expect.arrayContaining(["--system-prompt", "same system"]));
		expect(secondArgs).not.toContain("--system-prompt");
		expect(userEnvelopePayload(child)).toBe("first question");
		expect(userEnvelopePayload(spawnMock.mock.results[1].value)).toBe("follow-up");
	});

	it("catches up intervening non-Claude turns when returning to a sticky Claude session", () => {
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";

		const firstChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(new MockChildProcess());

		streamClaudeCli(
			model,
			contextWithMessages([{ role: "user", content: "planning question", timestamp: 1 }], "same system"),
			{},
		);
		writeJsonl(firstChild, [{ type: "result", subtype: "success", result: "plan", usage: {} }]);

		const messages: Message[] = [
			{ role: "user", content: "planning question", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "plan" }], timestamp: 2 } as Message,
			{ role: "user", content: "codex did implementation", timestamp: 3 },
			{ role: "assistant", content: [{ type: "text", text: "implementation complete" }], timestamp: 4 } as Message,
			{ role: "user", content: "review the result", timestamp: 5 },
		];

		streamClaudeCli(model, contextWithMessages(messages, "same system"), {});

		const secondPayload = userEnvelopePayload(spawnMock.mock.results[1].value);
		expect(secondPayload).toContain("Intervening Pi conversation since your last Claude turn");
		expect(secondPayload).not.toContain("planning question");
		expect(secondPayload).toContain("codex did implementation");
		expect(secondPayload).toContain("implementation complete");
		expect(secondPayload).toContain("review the result");
	});

	it("sends compacted prior context when the Pi transcript shrinks", () => {
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";

		const firstChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(new MockChildProcess());
		const firstMessages: Message[] = [
			{ role: "user", content: "one", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2 } as Message,
			{ role: "user", content: "three", timestamp: 3 },
			{ role: "assistant", content: [{ type: "text", text: "four" }], timestamp: 4 } as Message,
			{ role: "user", content: "five", timestamp: 5 },
		];

		streamClaudeCli(model, contextWithMessages(firstMessages, "same system"), {});
		writeJsonl(firstChild, [{ type: "result", subtype: "success", result: "six", usage: {} }]);

		const compactedMessages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "Compacted summary of intervening work" }],
				timestamp: 6,
			} as Message,
			{ role: "user", content: "continue from the summary", timestamp: 7 },
		];
		streamClaudeCli(model, contextWithMessages(compactedMessages, "same system"), {});

		const secondPayload = userEnvelopePayload(spawnMock.mock.results[1].value);
		expect(secondPayload).toContain("Compacted summary of intervening work");
		expect(secondPayload).toContain("continue from the summary");
	});

	it("does not reuse sticky Claude sessions across Pi process starts", () => {
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";

		const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
		Object.defineProperty(process, "pid", { configurable: true, value: 111 });
		streamClaudeCli(model, context("same system"), {});
		Object.defineProperty(process, "pid", { configurable: true, value: 222 });
		streamClaudeCli(model, context("same system"), {});

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--session-id") + 1];

		expect(secondSession).not.toBe(firstSession);
		if (originalPid) Object.defineProperty(process, "pid", originalPid);
	});

	it("reuses sticky Claude sessions across Pi process starts when a session id is provided", () => {
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";

		const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
		const firstChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(new MockChildProcess());
		Object.defineProperty(process, "pid", { configurable: true, value: 111 });
		streamClaudeCli(model, context("same system"), { sessionId: "session-1" });
		writeJsonl(firstChild, [{ type: "result", subtype: "success", result: "ok", usage: {} }]);
		Object.defineProperty(process, "pid", { configurable: true, value: 222 });
		streamClaudeCli(model, context("same system"), { sessionId: "session-1" });

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--resume") + 1];

		expect(secondSession).toBe(firstSession);
		if (originalPid) Object.defineProperty(process, "pid", originalPid);
	});

	it("reuses sticky session when pi-router-session marker matches even if agent block changes", () => {
		// Simulates the scenario where the router injects a stable marker but the
		// surrounding agent L2/L3 memory block changes between turns. The session
		// key should be stable because it's keyed on the marker digest, not the
		// full system prompt hash.
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";
		const firstChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(new MockChildProcess());

		const marker = `<!-- pi-router-session agent="agency/engineering/engineering-devops-automator" project="pi-infra" -->`;
		const turn1System = `${marker}\n\n<!-- pi-router: agent system-prompt prepend -->\nL2 content version A\n<!-- /pi-router: agent system-prompt prepend -->`;
		const turn2System = `${marker}\n\n<!-- pi-router: agent system-prompt prepend -->\nL2 content version B (different)\n<!-- /pi-router: agent system-prompt prepend -->`;

		streamClaudeCli(model, context(turn1System), { sessionId: "wk-abc" });
		writeJsonl(firstChild, [{ type: "result", subtype: "success", result: "ok", usage: {} }]);
		streamClaudeCli(model, context(turn2System), { sessionId: "wk-abc" });

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--resume") + 1];

		// Same session ID despite different L2 agent block content.
		expect(secondSession).toBe(firstSession);
	});

	it("reuses sticky session across pi-mono process boundaries when pi-router-session marker matches", () => {
		// Simulates the cross-pi-process workstream-reuse scenario:
		// - User starts pi window A, runs a turn → spawns Claude session S1.
		// - Pi window A is closed (or another pi window B is opened in parallel).
		// - Pi window B runs a turn in the SAME workstream (same agent + project).
		// Expected: window B's turn resumes S1 via SQLite registry, not a new spawn.
		// This is enforced by deriving the session-key boundary from the marker
		// digest when present, instead of from the per-pi-mono sessionId/pid.
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";
		process.env.TMUX_PANE = "%42";
		const originalPid = Object.getOwnPropertyDescriptor(process, "pid");
		const firstChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(new MockChildProcess());

		const marker = `<!-- pi-router-session agent="agency/engineering/engineering-devops-automator" project="pi-infra" -->`;
		const systemPrompt = `${marker}\n\nrest of the agent prepend block content`;

		// Window A: pid 111, pi-mono session "windowA-uuid"
		Object.defineProperty(process, "pid", { configurable: true, value: 111 });
		streamClaudeCli(model, context(systemPrompt), { sessionId: "windowA-uuid" });
		writeJsonl(firstChild, [{ type: "result", subtype: "success", result: "ok", usage: {} }]);

		// Window B: different pid AND different pi-mono session id, same workstream marker
		Object.defineProperty(process, "pid", { configurable: true, value: 222 });
		streamClaudeCli(model, context(systemPrompt), { sessionId: "windowB-uuid" });

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--resume") + 1];

		// Cross-pi-process reuse: same Claude session id resumed in window B.
		expect(secondSession).toBe(firstSession);
		expect(secondArgs).toContain("--resume");

		if (originalPid) Object.defineProperty(process, "pid", originalPid);
	});

	it("reuses a router sticky session across agent hops in the same project and pane", () => {
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";
		process.env.TMUX_PANE = "%7";
		const firstChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(new MockChildProcess());

		const turn1Marker = `<!-- pi-router-session agent="agency/engineering/engineering-backend-architect" project="pi-infra" -->`;
		const turn2Marker = `<!-- pi-router-session agent="agency/engineering/engineering-devops-automator" project="pi-infra" -->`;

		streamClaudeCli(model, context(`${turn1Marker}\n\nbackend context`), { sessionId: "windowA-uuid" });
		writeJsonl(firstChild, [{ type: "result", subtype: "success", result: "ok", usage: {} }]);
		streamClaudeCli(model, context(`${turn2Marker}\n\ndevops context`), { sessionId: "windowA-uuid" });

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--resume") + 1];

		expect(secondSession).toBe(firstSession);
		expect(secondArgs).toContain("--append-system-prompt");
		expect(secondArgs).toContain(`${turn2Marker}\n\ndevops context`);
	});

	it("does not share router sticky sessions across tmux panes", () => {
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";
		const marker = `<!-- pi-router-session agent="agency/engineering/engineering-devops-automator" project="pi-infra" -->`;

		process.env.TMUX_PANE = "%1";
		streamClaudeCli(model, context(marker), { sessionId: "same-session-id" });
		process.env.TMUX_PANE = "%2";
		streamClaudeCli(model, context(marker), { sessionId: "same-session-id" });

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--session-id") + 1];

		expect(secondSession).not.toBe(firstSession);
	});

	it("does NOT reuse sticky session across pi-mono process boundaries when no marker is present", () => {
		// Defensive: direct claude-cli calls outside the router (no marker) should
		// keep their per-pi-process isolation so unrelated pi instances don't
		// accidentally share Claude sessions.
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "1";
		const originalPid = Object.getOwnPropertyDescriptor(process, "pid");

		Object.defineProperty(process, "pid", { configurable: true, value: 111 });
		streamClaudeCli(model, context("plain system prompt, no router marker"), {});
		Object.defineProperty(process, "pid", { configurable: true, value: 222 });
		streamClaudeCli(model, context("plain system prompt, no router marker"), {});

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--session-id") + 1];

		expect(secondSession).not.toBe(firstSession);
		if (originalPid) Object.defineProperty(process, "pid", originalPid);
	});

	it("sends sticky Claude session IDs by default", () => {
		streamClaudeCli(model, context(), {});

		expect(spawnMock.mock.calls[0][1]).toContain("--session-id");
	});

	it("can disable sticky Claude session IDs explicitly", () => {
		process.env.PI_CLAUDE_CLI_STICKY_SESSIONS = "0";

		streamClaudeCli(model, context(), {});

		expect(spawnMock.mock.calls[0][1]).not.toContain("--session-id");
	});

	it("uses fresh one-shot Claude sessions when reuse is disabled by metadata", () => {
		process.env.PI_CLAUDE_CLI_WORKERS = "1";

		streamClaudeCli(model, context("summary system"), {
			metadata: { disableClaudeSessionReuse: true, sessionPurpose: "compaction" },
		});
		streamClaudeCli(model, context("summary system"), {
			metadata: { disableClaudeSessionReuse: true, sessionPurpose: "compaction" },
		});

		expect(spawnMock).toHaveBeenCalledTimes(2);
		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--session-id") + 1];

		expect(firstArgs).toContain("--session-id");
		expect(firstArgs).not.toContain("--resume");
		expect(secondArgs).toContain("--session-id");
		expect(secondArgs).not.toContain("--resume");
		expect(secondSession).not.toBe(firstSession);
	});

	it("keeps silent claude subprocess idle intervals out of the transcript by default", async () => {
		vi.useFakeTimers();
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const stream = streamClaudeCli(model, context(), { timeoutMs: 25 });
		const eventsPromise = collectEvents(stream);

		vi.advanceTimersByTime(25);

		expect(child.kill).not.toHaveBeenCalled();
		child.emit("close", 0);

		const events = await eventsPromise;
		expect(events.some((event) => event.type === "text_delta" && event.delta.includes("no claude-cli output"))).toBe(
			false,
		);
	});

	it("can opt into claude-cli activity text for debugging", async () => {
		vi.useFakeTimers();
		process.env.PI_CLAUDE_CLI_ACTIVITY_TEXT = "1";
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const stream = streamClaudeCli(model, context(), { timeoutMs: 25 });
		const eventsPromise = collectEvents(stream);

		vi.advanceTimersByTime(25);
		child.emit("close", 0);

		const events = await eventsPromise;
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text_delta",
					delta: expect.stringContaining("no claude-cli output for 1s; still waiting"),
				}),
			]),
		);
	});

	it("terminates claude subprocess when max runtime elapses", () => {
		vi.useFakeTimers();
		process.env.PI_CLAUDE_CLI_MAX_RUNTIME_MS = "25";
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		streamClaudeCli(model, context(), {});

		vi.advanceTimersByTime(25);

		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("keeps the sticky Claude session initialized after a max runtime timeout with activity", () => {
		vi.useFakeTimers();
		process.env.PI_CLAUDE_CLI_MAX_RUNTIME_MS = "25";
		const firstChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(new MockChildProcess());

		streamClaudeCli(model, context("same system"), {});
		writeJsonl(firstChild, [{ type: "system", subtype: "init", model: model.id, tools: ["Bash"] }]);
		vi.advanceTimersByTime(25);
		firstChild.emit("close", null);

		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "claude-cli max runtime timed out" }],
				timestamp: 2,
			} as Message,
			{ role: "user", content: "continue", timestamp: 3 },
		];
		streamClaudeCli(model, contextWithMessages(messages, "same system"), {});

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		expect(firstArgs).toEqual(expect.arrayContaining(["--system-prompt", "same system"]));
		expect(secondArgs).not.toContain("--system-prompt");
		expect(userEnvelopePayload(spawnMock.mock.results[1].value)).toBe("continue");
	});

	it("extends idle reporting when claude emits stream activity", () => {
		vi.useFakeTimers();
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		streamClaudeCli(model, context(), { timeoutMs: 25 });

		vi.advanceTimersByTime(20);
		writeJsonl(child, [{ type: "system", subtype: "status", status: "requesting" }]);
		vi.advanceTimersByTime(20);

		expect(child.kill).not.toHaveBeenCalled();

		vi.advanceTimersByTime(5);

		expect(child.kill).not.toHaveBeenCalled();
	});

	it("parses claude stream-json final text and usage", async () => {
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const stream = streamClaudeCli(model, context(), {});
		const eventsPromise = collectEvents(stream);

		writeJsonl(child, [
			{ type: "system", subtype: "init", model: "claude-haiku-4-5", tools: ["Bash", "Read"] },
			{
				type: "stream_event",
				event: {
					type: "message_start",
					message: { model: "claude-haiku-4-5-20251001" },
				},
			},
			{
				type: "stream_event",
				event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "he" } },
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "llo" } },
			},
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
			{
				type: "result",
				subtype: "success",
				result: "hello",
				total_cost_usd: 0.01,
				usage: {
					input_tokens: 2,
					output_tokens: 3,
					cache_read_input_tokens: 5,
					cache_creation_input_tokens: 7,
				},
			},
		]);
		child.emit("close", 0);

		const events = await eventsPromise;
		const done = events.find((event) => event.type === "done");
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("Expected done event");
		expect(done.message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(done.message.responseModel).toBe("claude-haiku-4-5-20251001");
		expect(done.message.usage).toMatchObject({
			input: 2,
			output: 3,
			cacheRead: 5,
			cacheWrite: 7,
			totalTokens: 17,
			cost: { total: 0 },
		});
	});

	it("keeps claude-cli tool activity out of assistant text by default without emitting Pi tool calls", async () => {
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const stream = streamClaudeCli(model, context(), {});
		const eventsPromise = collectEvents(stream);

		writeJsonl(child, [
			{ type: "system", subtype: "init", model: model.id, tools: ["Bash"] },
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: "Bash" },
				},
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
				},
			},
			{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" } } },
			{ type: "user", tool_use_result: { stdout: "/tmp", is_error: false } },
			{
				type: "stream_event",
				event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "/tmp" } },
			},
			{ type: "result", subtype: "success", result: "/tmp", usage: { input_tokens: 1, output_tokens: 1 } },
		]);
		child.emit("close", 0);

		const events = await eventsPromise;
		const textDeltas = events.filter((event) => event.type === "text_delta");
		expect(textDeltas.some((event) => event.type === "text_delta" && event.delta.includes("running Bash: pwd"))).toBe(
			false,
		);
		expect(events.some((event) => event.type === "toolcall_start" || event.type === "toolcall_end")).toBe(false);

		const done = events.find((event) => event.type === "done");
		if (done?.type !== "done") throw new Error("Expected done event");
		expect(done.message.content).toEqual([{ type: "text", text: "/tmp" }]);
	});

	it("surfaces claude-cli tool activity when activity text is enabled", async () => {
		process.env.PI_CLAUDE_CLI_ACTIVITY_TEXT = "1";
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const stream = streamClaudeCli(model, context(), {});
		const eventsPromise = collectEvents(stream);

		writeJsonl(child, [
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: "Bash" },
				},
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
				},
			},
			{ type: "result", subtype: "success", result: "/tmp", usage: { input_tokens: 1, output_tokens: 1 } },
		]);
		child.emit("close", 0);

		const events = await eventsPromise;
		expect(events.some((event) => event.type === "text_delta" && event.delta.includes("running Bash: pwd"))).toBe(
			true,
		);
	});

	it("surfaces Claude user-facing prompt tools as assistant text", async () => {
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const stream = streamClaudeCli(model, context(), {});
		const eventsPromise = collectEvents(stream);

		writeJsonl(child, [
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: "AskUserQuestion" },
				},
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: {
						type: "input_json_delta",
						partial_json:
							'{"question":"Which path should I take?","options":[{"label":"A","description":"Fast"},{"label":"B"}]}',
					},
				},
			},
			{ type: "result", subtype: "success", result: "", usage: { input_tokens: 1, output_tokens: 1 } },
		]);
		child.emit("close", 0);

		const events = await eventsPromise;
		const done = events.find((event) => event.type === "done");
		if (done?.type !== "done") throw new Error("Expected done event");
		expect(done.message.content).toEqual([{ type: "text", text: "Which path should I take?\n\n- A - Fast\n- B" }]);
	});

	it("preserves paragraph breaks between text blocks separated by Claude tool use", async () => {
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const stream = streamClaudeCli(model, context(), {});
		const eventsPromise = collectEvents(stream);

		writeJsonl(child, [
			{
				type: "stream_event",
				event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Before tool:" } },
			},
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 1,
					content_block: { type: "tool_use", id: "toolu_1", name: "Bash" },
				},
			},
			{ type: "stream_event", event: { type: "content_block_stop", index: 1 } },
			{ type: "user", tool_use_result: { stdout: "ok", is_error: false } },
			{
				type: "stream_event",
				event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "After tool." } },
			},
			{
				type: "result",
				subtype: "success",
				result: "Before tool:After tool.",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		]);
		child.emit("close", 0);

		const events = await eventsPromise;
		const done = events.find((event) => event.type === "done");
		if (done?.type !== "done") throw new Error("Expected done event");
		expect(done.message.content).toEqual([{ type: "text", text: "Before tool:\n\nAfter tool." }]);
	});

	it("preserves paragraph breaks between text blocks in long-lived Claude workers", async () => {
		process.env.PI_CLAUDE_CLI_WORKERS = "1";
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const stream = streamClaudeCli(model, context(), {});
		const eventsPromise = collectEvents(stream);

		writeJsonl(child, [
			{
				type: "stream_event",
				event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "First:" } },
			},
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
			{
				type: "stream_event",
				event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Read" } },
			},
			{ type: "stream_event", event: { type: "content_block_stop", index: 1 } },
			{ type: "user", tool_use_result: { stdout: "ok", is_error: false } },
			{
				type: "stream_event",
				event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Second." } },
			},
			{
				type: "result",
				subtype: "success",
				result: "First:Second.",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		]);

		const events = await eventsPromise;
		const done = events.find((event) => event.type === "done");
		if (done?.type !== "done") throw new Error("Expected done event");
		expect(done.message.content).toEqual([{ type: "text", text: "First:\n\nSecond." }]);
	});

	describe("session-resource cleanup waits for child exit", () => {
		it("attempts graceful stdin EOF before SIGTERM, and resolves once child closes", async () => {
			process.env.PI_CLAUDE_CLI_WORKERS = "1";
			vi.useFakeTimers();
			const child = new MockChildProcess();
			spawnMock.mockReturnValue(child);
			const stdinEndSpy = vi.spyOn(child.stdin, "end");

			streamClaudeCli(model, context(), {});

			let resolved = false;
			const cleanupPromise = _clearClaudeCliStickySessionsForTest().then(() => {
				resolved = true;
			});

			// Allow the cleanup microtasks to start so stdin.end() runs.
			await Promise.resolve();
			await Promise.resolve();
			expect(stdinEndSpy).toHaveBeenCalled();
			expect(child.kill).not.toHaveBeenCalled();
			expect(resolved).toBe(false);

			// Child exits cleanly before SIGTERM grace window — no signals fire.
			child.emit("close", 0);
			await cleanupPromise;
			expect(resolved).toBe(true);
			expect(child.kill).not.toHaveBeenCalled();
			vi.useRealTimers();
		});

		it("escalates to SIGTERM then SIGKILL when child does not close within timeout", async () => {
			process.env.PI_CLAUDE_CLI_WORKERS = "1";
			process.env.PI_CLAUDE_CLI_SHUTDOWN_TIMEOUT_MS = "400";
			vi.useFakeTimers();
			const child = new MockChildProcess();
			spawnMock.mockReturnValue(child);

			streamClaudeCli(model, context(), {});

			let resolved = false;
			const cleanupPromise = _clearClaudeCliStickySessionsForTest().then(() => {
				resolved = true;
			});

			await Promise.resolve();
			await Promise.resolve();

			// Advance past the SIGTERM timer (min(300, 400/4) = 100ms).
			await vi.advanceTimersByTimeAsync(150);
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(resolved).toBe(false);

			// Advance past the SIGKILL timer (400ms total). Cleanup must resolve
			// even though the child never emitted 'close' — /quit cannot hang.
			await vi.advanceTimersByTimeAsync(400);
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
			await cleanupPromise;
			expect(resolved).toBe(true);
			vi.useRealTimers();
			delete process.env.PI_CLAUDE_CLI_SHUTDOWN_TIMEOUT_MS;
		});

		it("respects PI_CLAUDE_CLI_SHUTDOWN_TIMEOUT_MS override", async () => {
			process.env.PI_CLAUDE_CLI_WORKERS = "1";
			process.env.PI_CLAUDE_CLI_SHUTDOWN_TIMEOUT_MS = "1200";
			vi.useFakeTimers();
			const child = new MockChildProcess();
			spawnMock.mockReturnValue(child);

			streamClaudeCli(model, context(), {});

			let resolved = false;
			const cleanupPromise = _clearClaudeCliStickySessionsForTest().then(() => {
				resolved = true;
			});

			await Promise.resolve();
			await Promise.resolve();

			// Default timeout is 2000ms; with override at 1200ms the SIGKILL fires
			// well before that. Advance to 1100ms — still below override — and
			// confirm cleanup hasn't resolved yet.
			await vi.advanceTimersByTimeAsync(1100);
			expect(resolved).toBe(false);

			// Cross the 1200ms override boundary.
			await vi.advanceTimersByTimeAsync(200);
			await cleanupPromise;
			expect(resolved).toBe(true);
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
			vi.useRealTimers();
			delete process.env.PI_CLAUDE_CLI_SHUTDOWN_TIMEOUT_MS;
		});
	});
});
