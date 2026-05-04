import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamClaudeCli } from "../src/providers/claude-cli.js";
import type { AssistantMessageEvent, Context, Model } from "../src/types.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

class MockChildProcess extends EventEmitter {
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
		spawnMock.mockReset();
		spawnMock.mockReturnValue(new MockChildProcess());
	});

	it("spawns claude without a system prompt flag when context has no system prompt", () => {
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

	it("passes a non-empty system prompt via --append-system-prompt", () => {
		streamClaudeCli(model, context(" route instructions\n"), {});

		expect(spawnMock.mock.calls[0][1]).toEqual(
			expect.arrayContaining(["--append-system-prompt", " route instructions\n", "hello"]),
		);
	});

	it("skips --append-system-prompt for whitespace-only system prompts", () => {
		streamClaudeCli(model, context(" \n\t "), {});

		expect(spawnMock.mock.calls[0][1]).not.toContain("--append-system-prompt");
		expect(spawnMock.mock.calls[0][1]).toContain("hello");
	});

	it("passes multiline shell-looking system prompts as one argv element", () => {
		const systemPrompt = "first line\nsecond '$HOME' `rm -rf /`; $(echo nope)";

		streamClaudeCli(model, context(systemPrompt), {});

		expect(spawnMock.mock.calls[0][1]).toEqual(
			expect.arrayContaining(["--append-system-prompt", systemPrompt, "hello"]),
		);
		expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("shell");
	});

	it("terminates a hung claude subprocess when timeoutMs elapses", () => {
		vi.useFakeTimers();
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		streamClaudeCli(model, context(), { timeoutMs: 25 });

		vi.advanceTimersByTime(25);

		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
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
