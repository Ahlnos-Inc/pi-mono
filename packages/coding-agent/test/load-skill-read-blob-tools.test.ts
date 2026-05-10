import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { SessionBlobStore } from "../src/core/session-blob-store.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { createLoadSkillToolDefinition } from "../src/core/tools/load-skill.js";
import { createReadBlobToolDefinition } from "../src/core/tools/read-blob.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-load-skill-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LoadSkill tool", () => {
	it("loads a skill by catalog name", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "SKILL.md");
		await writeFile(
			filePath,
			"---\nname: sample\ndescription: Sample skill.\n---\n\n# Sample\n\nUse carefully.\n",
			"utf8",
		);
		const skills: Skill[] = [
			{
				name: "sample",
				description: "Sample skill.",
				filePath,
				baseDir: dir,
				sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
				disableModelInvocation: false,
			},
		];

		const tool = createLoadSkillToolDefinition(() => skills);
		const result = await tool.execute("tool-1", { name: "sample" }, undefined, undefined, {} as ExtensionContext);

		expect(result.details).toMatchObject({ name: "sample", location: filePath, baseDir: dir });
		expect(result.content[0]).toMatchObject({ type: "text" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain(`<skill name="sample" location="${filePath}">`);
		expect(text).toContain(`References are relative to ${dir}.`);
		expect(text).toContain("# Sample");
	});

	it("returns an error for unknown skills", async () => {
		const tool = createLoadSkillToolDefinition(() => []);
		const result = await tool.execute("tool-1", { name: "missing" }, undefined, undefined, {} as ExtensionContext);

		expect(result.content).toEqual([{ type: "text", text: "Skill not found: missing" }]);
	});
});

describe("ReadBlob tool", () => {
	it("loads full stored text by blob id", async () => {
		const dir = await createTempDir();
		const blobStore = new SessionBlobStore(SessionManager.create(dir, join(dir, "sessions")));
		const blob = blobStore.write({ toolName: "bash", text: "full output" });
		const tool = createReadBlobToolDefinition(blobStore);

		const result = await tool.execute("tool-1", { id: blob.id }, undefined, undefined, {} as ExtensionContext);

		expect(result.details).toEqual({ id: blob.id, toolName: "bash" });
		expect(result.content).toEqual([{ type: "text", text: "full output" }]);
	});

	it("rejects missing blobs", async () => {
		const dir = await createTempDir();
		const blobStore = new SessionBlobStore(SessionManager.create(dir, join(dir, "sessions")));
		const tool = createReadBlobToolDefinition(blobStore);
		const id = "00000000-0000-4000-8000-000000000000";

		const result = await tool.execute("tool-1", { id }, undefined, undefined, {} as ExtensionContext);

		expect(result.content).toEqual([{ type: "text", text: `Blob not found: ${id}` }]);
	});
});
