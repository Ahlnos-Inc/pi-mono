import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRegistry } from "./model-registry.ts";

const STUB_AUTH = {
	hasAuth: () => false,
	getAuthStatus: () => ({ configured: false }),
	getApiKey: async () => undefined,
	get: () => undefined,
	getOAuthProviders: () => [],
} as any;

describe("ModelRegistry OLLAMA_BASE_URL override", () => {
	let dir: string;
	let modelsPath: string;
	const ORIG_ENV = process.env.OLLAMA_BASE_URL;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-models-"));
		modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					ollama: {
						baseUrl: "http://100.80.239.26:11434/v1",
						api: "openai-completions",
						apiKey: "ollama",
						models: [{ id: "qwen2.5-3b-ctx32k", contextWindow: 32768, maxTokens: 1024 }],
					},
				},
			}),
		);
	});

	afterEach(() => {
		if (ORIG_ENV === undefined) delete process.env.OLLAMA_BASE_URL;
		else process.env.OLLAMA_BASE_URL = ORIG_ENV;
		rmSync(dir, { recursive: true, force: true });
	});

	it("uses tracked baseUrl when OLLAMA_BASE_URL is unset", () => {
		delete process.env.OLLAMA_BASE_URL;
		const reg = ModelRegistry.create(STUB_AUTH, modelsPath);
		const ollama = reg.getAll().find((m) => m.provider === "ollama" && m.id === "qwen2.5-3b-ctx32k");
		expect(ollama?.baseUrl).toBe("http://100.80.239.26:11434/v1");
	});

	it("overrides ollama baseUrl when OLLAMA_BASE_URL is set", () => {
		process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
		const reg = ModelRegistry.create(STUB_AUTH, modelsPath);
		const ollama = reg.getAll().find((m) => m.provider === "ollama" && m.id === "qwen2.5-3b-ctx32k");
		expect(ollama?.baseUrl).toBe("http://127.0.0.1:11434/v1");
	});

	it("does not override non-ollama providers when OLLAMA_BASE_URL is set", () => {
		process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
		const reg = ModelRegistry.create(STUB_AUTH, modelsPath);
		const nonOllama = reg.getAll().filter((m) => m.provider !== "ollama");
		for (const m of nonOllama) {
			expect(m.baseUrl).not.toBe("http://127.0.0.1:11434/v1");
		}
	});

	it("treats empty string OLLAMA_BASE_URL as unset", () => {
		process.env.OLLAMA_BASE_URL = "";
		const reg = ModelRegistry.create(STUB_AUTH, modelsPath);
		const ollama = reg.getAll().find((m) => m.provider === "ollama" && m.id === "qwen2.5-3b-ctx32k");
		expect(ollama?.baseUrl).toBe("http://100.80.239.26:11434/v1");
	});

	it("merges ignored models.local.json over tracked models.json", () => {
		delete process.env.OLLAMA_BASE_URL;
		writeFileSync(
			join(dir, "models.local.json"),
			JSON.stringify({
				providers: {
					ollama: {
						baseUrl: "http://127.0.0.1:11434/v1",
						api: "openai-completions",
						apiKey: "ollama",
						models: [
							{ id: "qwen2.5-3b-ctx32k", contextWindow: 32768, maxTokens: 4096 },
							{ id: "qwen3-coder:30b", contextWindow: 262144, maxTokens: 8192 },
						],
					},
				},
			}),
		);

		const reg = ModelRegistry.create(STUB_AUTH, modelsPath);
		const replaced = reg.getAll().find((m) => m.provider === "ollama" && m.id === "qwen2.5-3b-ctx32k");
		const localOnly = reg.getAll().find((m) => m.provider === "ollama" && m.id === "qwen3-coder:30b");
		expect(replaced?.baseUrl).toBe("http://127.0.0.1:11434/v1");
		expect(replaced?.contextWindow).toBe(32768);
		expect(localOnly?.baseUrl).toBe("http://127.0.0.1:11434/v1");
		expect(localOnly?.maxTokens).toBe(8192);
	});
});
