import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
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

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			// Create SettingsManager (simulates pi starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.json externally to add enabledModels
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("settings.local.json overlays", () => {
		it("should merge global and project local overlays after tracked settings", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					theme: "shared",
					defaultProvider: "shared-provider",
					terminal: { showImages: true, imageWidthCells: 40 },
					enabledModels: ["shared-a", "shared-b"],
				}),
			);
			writeFileSync(
				join(agentDir, "settings.local.json"),
				JSON.stringify({
					defaultProvider: "local-provider",
					terminal: { imageWidthCells: 80 },
					enabledModels: ["local-only"],
				}),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({
					defaultModel: "project-model",
					terminal: { showImages: false },
				}),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.local.json"),
				JSON.stringify({
					defaultModel: "project-local-model",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTheme()).toBe("shared");
			expect(manager.getDefaultProvider()).toBe("local-provider");
			expect(manager.getDefaultModel()).toBe("project-local-model");
			expect(manager.getImageWidthCells()).toBe(80);
			expect(manager.getShowImages()).toBe(false);
			expect(manager.getEnabledModels()).toEqual(["local-only"]);
		});

		it("should not leak local overlay values into tracked settings when saving unrelated fields", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const localSettingsPath = join(agentDir, "settings.local.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "shared" }));
			writeFileSync(
				localSettingsPath,
				JSON.stringify({ defaultModel: "local-model", enabledModels: ["local-only"] }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings).toEqual({ theme: "shared", defaultThinkingLevel: "high" });
			expect(JSON.parse(readFileSync(localSettingsPath, "utf-8"))).toEqual({
				defaultModel: "local-model",
				enabledModels: ["local-only"],
			});
			expect(manager.getDefaultModel()).toBe("local-model");
		});

		it("should keep local overlay masked values in memory while persisting same-key UI changes to tracked settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const localSettingsPath = join(agentDir, "settings.local.json");
			writeFileSync(settingsPath, JSON.stringify({ defaultModel: "shared-model" }));
			writeFileSync(localSettingsPath, JSON.stringify({ defaultModel: "local-model" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setDefaultModel("new-shared-model");
			await manager.flush();

			expect(JSON.parse(readFileSync(settingsPath, "utf-8")).defaultModel).toBe("new-shared-model");
			expect(JSON.parse(readFileSync(localSettingsPath, "utf-8")).defaultModel).toBe("local-model");
			expect(manager.getDefaultModel()).toBe("local-model");
		});

		it("should surface malformed local overlays without poisoning runtime settings", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			writeFileSync(join(agentDir, "settings.local.json"), "{ invalid global local json");
			writeFileSync(join(projectDir, ".pi", "settings.local.json"), "{ invalid project local json");

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTheme()).toBe("dark");
			const errors = manager.drainErrors();
			expect(errors.map((e) => e.scope).sort()).toEqual(["globalLocal", "projectLocal"]);
		});

		it("should reload settings.local.json changes from disk", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "shared-model" }));
			writeFileSync(join(agentDir, "settings.local.json"), JSON.stringify({ defaultModel: "first-local" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getDefaultModel()).toBe("first-local");

			writeFileSync(join(agentDir, "settings.local.json"), JSON.stringify({ defaultModel: "second-local" }));
			await manager.reload();

			expect(manager.getDefaultModel()).toBe("second-local");
		});

		it("should migrate legacy keys from local overlays", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
			writeFileSync(join(agentDir, "settings.local.json"), JSON.stringify({ queueMode: "all" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getSteeringMode()).toBe("all");
			expect(manager.getGlobalLocalSettings()).toEqual({ steeringMode: "all" });
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings when file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors.map((e) => e.scope).sort()).toEqual(["global", "project"]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .pi folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .pi folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT exist yet
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .pi folder should exist
			expect(existsSync(join(projectDir, ".pi"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".pi", "settings.json"))).toBe(true);
		});
	});

	describe("httpIdleTimeoutMs", () => {
		it("should default to 5 minutes", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getHttpIdleTimeoutMs()).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		});

		it("should use merged global and project settings", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 300000 }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 0 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getHttpIdleTimeoutMs()).toBe(0);
		});

		it("should reject invalid timeout values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: -1 }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(() => manager.getHttpIdleTimeoutMs()).toThrow("Invalid httpIdleTimeoutMs setting");
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ sessionDir: "./sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});
});
