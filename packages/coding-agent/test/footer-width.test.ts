import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	contextUsage?: { contextWindow: number; percent: number | null };
	agentChosen?: string | null;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];
	const branch =
		options.agentChosen === undefined
			? entries
			: [
					...entries,
					{
						type: "custom",
						customType: "pi-router/decision",
						data: {
							agent_chosen: options.agentChosen,
						},
					},
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branch,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => options.contextUsage,
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("does not render unknown context usage as 0%", () => {
		const footerWithoutUsage = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		const outputWithoutUsage = footerWithoutUsage.render(120).join("\n");
		expect(outputWithoutUsage).toContain("?/200k");
		expect(outputWithoutUsage).not.toContain("0.0%/200k");

		const footerWithUnknownUsage = new FooterComponent(
			createSession({ sessionName: "", contextUsage: { contextWindow: 200_000, percent: null } }),
			createFooterData(1),
		);
		const outputWithUnknownUsage = footerWithUnknownUsage.render(120).join("\n");
		expect(outputWithUnknownUsage).toContain("?/200k");
		expect(outputWithUnknownUsage).not.toContain("0.0%/200k");
	});

	it("shows the current agency agent from the latest router decision", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				agentChosen: "agency/engineering/engineering-devops-automator",
			}),
			createFooterData(1),
		);

		const output = footer.render(120).join("\n");
		expect(output).toContain("agent:engineering/devops-automator");
	});

	it("shows agent:none when the latest router decision has no agency agent", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				agentChosen: null,
			}),
			createFooterData(1),
		);

		const output = footer.render(120).join("\n");
		expect(output).toContain("agent:none");
	});
});
