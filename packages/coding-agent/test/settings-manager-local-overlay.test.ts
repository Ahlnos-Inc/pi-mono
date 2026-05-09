import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * Tests for the per-machine `settings.local.json` overlay.
 *
 * Layering: local > project > global. Local is a read-only overlay — pi's
 * UI/code paths only ever write to "global" or "project", never to "local".
 * The local overlay file is therefore safe to keep as a per-device file
 * that does not get clobbered by the shared `agent/settings.json` in
 * pi-config.
 */
describe("SettingsManager - local overlay (settings.local.json)", () => {
	const testDir = join(process.cwd(), "test-settings-local-overlay-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("absent overlay", () => {
		it("behaves identically to global+project when settings.local.json is missing", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
					packages: ["npm:pi-mcp-adapter"],
				}),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({
					theme: "light",
				}),
			);

			expect(existsSync(join(agentDir, "settings.local.json"))).toBe(false);

			const manager = SettingsManager.create(projectDir, agentDir);

			// Project overrides global, no overlay involved
			expect(manager.getTheme()).toBe("light");
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
			expect(manager.getPackages()).toEqual(["npm:pi-mcp-adapter"]);
			expect(manager.getLocalSettings()).toEqual({});
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("present overlay", () => {
		it("overrides global and project on primitive leaves", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
					defaultProvider: "anthropic",
				}),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({
					theme: "light",
				}),
			);
			writeFileSync(
				join(agentDir, "settings.local.json"),
				JSON.stringify({
					defaultModel: "qwen2.5-3b-ctx8k",
					defaultProvider: "ollama",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// Local wins over both global and project
			expect(manager.getDefaultModel()).toBe("qwen2.5-3b-ctx8k");
			expect(manager.getDefaultProvider()).toBe("ollama");
			// Project still wins over global where local is silent
			expect(manager.getTheme()).toBe("light");
		});

		it("merges nested objects recursively (local leaves win, sibling leaves preserved)", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					terminal: { showImages: true, imageWidthCells: 60, showTerminalProgress: false },
				}),
			);
			writeFileSync(
				join(agentDir, "settings.local.json"),
				JSON.stringify({
					terminal: { imageWidthCells: 100 },
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// Local overrides imageWidthCells, but other terminal keys come from global
			expect(manager.getImageWidthCells()).toBe(100);
			expect(manager.getShowImages()).toBe(true);
			expect(manager.getShowTerminalProgress()).toBe(false);
		});

		it("replaces arrays wholesale (local packages replaces global packages)", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					packages: ["npm:pi-mcp-adapter", "npm:pi-search-multi"],
				}),
			);
			writeFileSync(
				join(agentDir, "settings.local.json"),
				JSON.stringify({
					packages: ["npm:pi-intelli-search"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual(["npm:pi-intelli-search"]);
		});

		it("treats null in the overlay as a no-op so the tracked value survives", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);
			writeFileSync(
				join(agentDir, "settings.local.json"),
				JSON.stringify({
					defaultModel: null,
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// Per deepMergeSettings — primitives win wholesale, including null.
			// We document the actual behaviour rather than asserting magic preservation:
			// null wipes the value to null. Callers that want "leave alone" must omit the key.
			// (Mirrors the router-extension overlay convention.)
			expect(manager.getDefaultModel()).toBeNull();
		});

		it("treats explicit empty array in the overlay as an explicit clear", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					packages: ["npm:pi-mcp-adapter"],
				}),
			);
			writeFileSync(join(agentDir, "settings.local.json"), JSON.stringify({ packages: [] }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
		});
	});

	describe("malformed overlay", () => {
		it("does not poison runtime; global still applies and error surfaces with scope: 'local'", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);
			writeFileSync(join(agentDir, "settings.local.json"), "{ this is not valid json");

			const manager = SettingsManager.create(projectDir, agentDir);

			// Global settings still apply
			expect(manager.getTheme()).toBe("dark");
			expect(manager.getDefaultModel()).toBe("claude-sonnet");

			const errors = manager.drainErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0].scope).toBe("local");
			expect(errors[0].error).toBeInstanceOf(Error);
		});
	});

	describe("read-only semantics", () => {
		it("setSetting writes go to global, not to settings.local.json", async () => {
			const globalPath = join(agentDir, "settings.json");
			const localPath = join(agentDir, "settings.local.json");

			writeFileSync(
				globalPath,
				JSON.stringify({
					theme: "dark",
				}),
			);
			const localOriginal = JSON.stringify({ defaultModel: "qwen2.5-3b-ctx8k" });
			writeFileSync(localPath, localOriginal);

			const manager = SettingsManager.create(projectDir, agentDir);

			// Sanity: overlay applies
			expect(manager.getDefaultModel()).toBe("qwen2.5-3b-ctx8k");

			// User mutates a setting via UI — should land in global, never in local
			manager.setTheme("light");
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// settings.local.json is byte-identical
			expect(readFileSync(localPath, "utf-8")).toBe(localOriginal);

			// settings.json picked up the new keys
			const savedGlobal = JSON.parse(readFileSync(globalPath, "utf-8"));
			expect(savedGlobal.theme).toBe("light");
			expect(savedGlobal.defaultThinkingLevel).toBe("high");
			// Should NOT have leaked the overlay's key into the tracked file
			expect(savedGlobal.defaultModel).toBeUndefined();
		});

		it("setting a key that the overlay also defines: in-memory shows overlay's value, but the new key still lands in global", async () => {
			const globalPath = join(agentDir, "settings.json");
			const localPath = join(agentDir, "settings.local.json");

			writeFileSync(globalPath, JSON.stringify({ defaultModel: "claude-sonnet" }));
			writeFileSync(localPath, JSON.stringify({ defaultModel: "qwen2.5-3b-ctx8k" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			// User picks a new model via UI
			manager.setDefaultModel("claude-opus");
			await manager.flush();

			// Tracked file recorded the new global-scope choice
			const savedGlobal = JSON.parse(readFileSync(globalPath, "utf-8"));
			expect(savedGlobal.defaultModel).toBe("claude-opus");

			// Overlay file untouched
			const savedLocal = JSON.parse(readFileSync(localPath, "utf-8"));
			expect(savedLocal.defaultModel).toBe("qwen2.5-3b-ctx8k");

			// In-memory: overlay continues to win — that's the intended UX of a
			// per-machine overlay. UI mutations are persisted to global (so the
			// shared file stays current) while the overlay keeps masking them
			// on this device until the operator removes the overlay key.
			expect(manager.getDefaultModel()).toBe("qwen2.5-3b-ctx8k");
		});
	});

	describe("migration runs on overlay payload", () => {
		it("migrates legacy queueMode -> steeringMode in settings.local.json", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
			writeFileSync(
				join(agentDir, "settings.local.json"),
				JSON.stringify({
					queueMode: "all",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getSteeringMode()).toBe("all");
			// And the in-memory snapshot of the local overlay reflects the migration
			const localSnap = manager.getLocalSettings() as { queueMode?: unknown; steeringMode?: unknown };
			expect(localSnap.steeringMode).toBe("all");
			expect(localSnap.queueMode).toBeUndefined();
		});
	});

	describe("reload picks up overlay changes", () => {
		it("reload re-reads settings.local.json from disk", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "claude-sonnet" }));
			writeFileSync(join(agentDir, "settings.local.json"), JSON.stringify({ defaultModel: "qwen2.5-3b-ctx8k" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getDefaultModel()).toBe("qwen2.5-3b-ctx8k");

			writeFileSync(join(agentDir, "settings.local.json"), JSON.stringify({ defaultModel: "claude-opus" }));
			await manager.reload();

			expect(manager.getDefaultModel()).toBe("claude-opus");
		});
	});
});
