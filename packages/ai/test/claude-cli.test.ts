import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
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
	kill = vi.fn();
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

describe("claude-cli provider", () => {
	beforeEach(() => {
		vi.useRealTimers();
		delete process.env.PI_CLAUDE_CLI_INCLUDE_USER_CONTEXT;
		delete process.env.PI_CLAUDE_CLI_STICKY_SESSIONS;
		delete process.env.PI_CLAUDE_CLI_MAX_RUNTIME_MS;
		_clearClaudeCliStickySessionsForTest();
		spawnMock.mockReset();
		spawnMock.mockReturnValue(new MockChildProcess());
	});

	it("spawns claude with core tools and scoped settings by default", () => {
		streamClaudeCli(model, context(), {});

		expect(spawnMock).toHaveBeenCalledWith(
			"claude",
			expect.arrayContaining([
				"-p",
				"--verbose",
				"--output-format",
				"stream-json",
				"--include-partial-messages",
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
				"hello",
			]),
			{
				env: expect.any(Object),
				cwd: `${process.env.HOME ?? "/root"}/projects/ahlnos`,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("shell");
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

		expect(spawnMock.mock.calls[0][1]).toEqual(
			expect.arrayContaining(["--system-prompt", " route instructions\n", "hello"]),
		);
	});

	it("skips --system-prompt for whitespace-only system prompts", () => {
		streamClaudeCli(model, context(" \n\t "), {});

		expect(spawnMock.mock.calls[0][1]).not.toContain("--system-prompt");
		expect(spawnMock.mock.calls[0][1]).toContain("hello");
	});

	it("passes multiline shell-looking system prompts as one argv element", () => {
		const systemPrompt = "first line\nsecond '$HOME' `rm -rf /`; $(echo nope)";

		streamClaudeCli(model, context(systemPrompt), {});

		expect(spawnMock.mock.calls[0][1]).toEqual(expect.arrayContaining(["--system-prompt", systemPrompt, "hello"]));
		expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("shell");
	});

	it("passes large prompts through stdin instead of argv to avoid E2BIG", () => {
		const largePrompt = "x".repeat(70 * 1024);
		const child = new MockChildProcess();
		const stdinEnd = vi.spyOn(child.stdin, "end");
		spawnMock.mockReturnValueOnce(child);

		streamClaudeCli(model, contextWithMessages([{ role: "user", content: largePrompt, timestamp: 1 }]), {});

		const args = spawnMock.mock.calls[0][1] as string[];
		expect(args).not.toContain(largePrompt);
		expect(spawnMock.mock.calls[0][2]).toMatchObject({ stdio: ["pipe", "pipe", "pipe"] });
		expect(stdinEnd).toHaveBeenCalledWith(largePrompt);
	});

	it("passes large system prompts through a file instead of argv to avoid E2BIG", () => {
		const largeSystemPrompt = "system\n" + "y".repeat(70 * 1024);
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

		streamClaudeCli(model, context("same system"), {});
		streamClaudeCli(model, context("same system"), {});

		const firstArgs = spawnMock.mock.calls[0][1] as string[];
		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1];
		const secondSession = secondArgs[secondArgs.indexOf("--session-id") + 1];

		expect(firstSession).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(secondSession).toBe(firstSession);
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
		expect(firstArgs.at(-1)).toBe("first question");
		expect(secondArgs).not.toContain("--system-prompt");
		expect(secondArgs.at(-1)).toBe("follow-up");
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

		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		expect(secondArgs.at(-1)).toContain("Intervening Pi conversation since your last Claude turn");
		expect(secondArgs.at(-1)).not.toContain("planning question");
		expect(secondArgs.at(-1)).toContain("codex did implementation");
		expect(secondArgs.at(-1)).toContain("implementation complete");
		expect(secondArgs.at(-1)).toContain("review the result");
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

		const secondArgs = spawnMock.mock.calls[1][1] as string[];
		expect(secondArgs.at(-1)).toContain("Compacted summary of intervening work");
		expect(secondArgs.at(-1)).toContain("continue from the summary");
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

	it("does not send sticky Claude session IDs by default", () => {
		streamClaudeCli(model, context(), {});

		expect(spawnMock.mock.calls[0][1]).not.toContain("--session-id");
	});

	it("reports silent claude subprocess idle intervals without terminating it", async () => {
		vi.useFakeTimers();
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const stream = streamClaudeCli(model, context(), { timeoutMs: 25 });
		const eventsPromise = collectEvents(stream);

		vi.advanceTimersByTime(25);

		expect(child.kill).not.toHaveBeenCalled();
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

	it("surfaces claude-cli tool activity without emitting Pi tool calls", async () => {
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
			true,
		);
		expect(events.some((event) => event.type === "toolcall_start" || event.type === "toolcall_end")).toBe(false);

		const done = events.find((event) => event.type === "done");
		if (done?.type !== "done") throw new Error("Expected done event");
		expect(done.message.content).toEqual([{ type: "text", text: "/tmp" }]);
	});
});
