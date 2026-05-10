import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBlobStore } from "../src/core/session-blob-store.js";
import { SessionManager } from "../src/core/session-manager.js";
import { formatGuardedOutput, guardBashResult, guardToolResultContent } from "../src/core/tool-result-guard.js";

const tempDirs: string[] = [];

async function createBlobStore(): Promise<SessionBlobStore> {
	const dir = await mkdtemp(join(tmpdir(), "pi-blob-store-"));
	tempDirs.push(dir);
	return new SessionBlobStore(SessionManager.create(dir, join(dir, "sessions")));
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("tool result guard", () => {
	it("leaves small tool results unchanged", async () => {
		const blobStore = await createBlobStore();
		const guarded = await guardToolResultContent({
			toolName: "read",
			content: [{ type: "text", text: "small output" }],
			settings: { summarizeOver: 100, summaryModel: "test/model" },
			blobStore,
			summarize: async () => {
				throw new Error("should not summarize");
			},
		});

		expect(guarded).toBeUndefined();
	});

	it("stores large tool results and replaces them with a summary marker", async () => {
		const blobStore = await createBlobStore();
		const original = "line\n".repeat(20);
		const guarded = await guardToolResultContent({
			toolName: "read",
			content: [{ type: "text", text: original }],
			details: { path: "large.txt" },
			settings: { summarizeOver: 10, summaryModel: "test/model" },
			blobStore,
			summarize: async (text, metadata) => `summary for ${metadata.toolName}: ${text.length}`,
		});

		expect(guarded).toBeDefined();
		expect(guarded?.content[0]).toMatchObject({ type: "text" });
		const text = guarded?.content[0]?.type === "text" ? guarded.content[0].text : "";
		expect(text).toContain("Tool output summary");
		expect(text).toContain("summary for read");
		expect(text).toContain("session-blob://");
		expect(guarded?.details).toMatchObject({ toolResultGuard: { summarized: true, originalChars: original.length } });
		expect(blobStore.read(guarded!.blobId!)?.content).toEqual([{ type: "text", text: original }]);
	});

	it("falls back to a leading excerpt when summarization fails", async () => {
		const blobStore = await createBlobStore();
		const guarded = await guardToolResultContent({
			toolName: "bash",
			content: [{ type: "text", text: "first\nsecond\nthird" }],
			settings: { summarizeOver: 5, summaryModel: "test/model" },
			blobStore,
			summarize: async () => {
				throw new Error("summary unavailable");
			},
		});

		const text = guarded?.content[0]?.type === "text" ? guarded.content[0].text : "";
		expect(text).toContain("Automatic model summary failed");
		expect(text).toContain("first\nsecond\nthird");
	});

	it("stores and summarizes large bash output", async () => {
		const blobStore = await createBlobStore();
		const result = await guardBashResult(
			"printf big",
			{ output: "abc".repeat(20), exitCode: 0, truncated: false, cancelled: false },
			{
				settings: { summarizeOver: 10, summaryModel: "test/model" },
				blobStore,
				summarize: async () => "bash summary",
			},
		);

		expect(result.output).toContain("bash summary");
		expect(result.output).toContain("session-blob://");
		expect(result.truncated).toBe(true);
	});

	it("formats markers with ReadBlob instructions", () => {
		expect(formatGuardedOutput("summary", "00000000-0000-4000-8000-000000000000", 123)).toContain(
			"use ReadBlob(00000000-0000-4000-8000-000000000000)",
		);
	});
});
