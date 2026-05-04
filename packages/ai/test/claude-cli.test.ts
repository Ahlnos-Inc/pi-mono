import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamClaudeCli } from "../src/providers/claude-cli.js";
import type { Context, Model } from "../src/types.js";

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

describe("claude-cli provider", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		spawnMock.mockReturnValue(new MockChildProcess());
	});

	it("spawns claude without a system prompt flag when context has no system prompt", () => {
		streamClaudeCli(model, context(), {});

		expect(spawnMock).toHaveBeenCalledWith("claude", ["-p", "--model", model.id, "hello"], {
			env: expect.any(Object),
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("shell");
	});

	it("passes a non-empty system prompt via --append-system-prompt", () => {
		streamClaudeCli(model, context(" route instructions\n"), {});

		expect(spawnMock.mock.calls[0][1]).toEqual([
			"-p",
			"--model",
			model.id,
			"--append-system-prompt",
			" route instructions\n",
			"hello",
		]);
	});

	it("skips --append-system-prompt for whitespace-only system prompts", () => {
		streamClaudeCli(model, context(" \n\t "), {});

		expect(spawnMock.mock.calls[0][1]).toEqual(["-p", "--model", model.id, "hello"]);
	});

	it("passes multiline shell-looking system prompts as one argv element", () => {
		const systemPrompt = "first line\nsecond '$HOME' `rm -rf /`; $(echo nope)";

		streamClaudeCli(model, context(systemPrompt), {});

		expect(spawnMock.mock.calls[0][1]).toEqual([
			"-p",
			"--model",
			model.id,
			"--append-system-prompt",
			systemPrompt,
			"hello",
		]);
		expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("shell");
	});
});
