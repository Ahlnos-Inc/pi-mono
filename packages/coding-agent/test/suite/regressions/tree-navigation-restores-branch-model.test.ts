import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

describe("tree navigation branch state restoration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("restores model and thinking from the selected branch without writing history", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		harness.setResponses([fauxAssistantMessage("plan"), fauxAssistantMessage("review")]);
		await harness.session.prompt("design a plan");

		const planAssistant = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(planAssistant).toBeDefined();

		await harness.session.setModel(harness.getModel("faux-2")!);
		await harness.session.prompt("review the plan");
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("off");

		const entryCountsBefore = countStateEntries(harness);
		modelEvents.length = 0;

		const result = await harness.session.navigateTree(planAssistant!.id, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(getAssistantTexts(harness)).toEqual(["plan"]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(modelEvents).toEqual(["faux-2->faux-1:restore"]);
		expect(countStateEntries(harness)).toEqual(entryCountsBefore);
	});
});

function countStateEntries(harness: Harness): { modelChanges: number; thinkingChanges: number } {
	const entries = harness.sessionManager.getEntries();
	return {
		modelChanges: entries.filter((entry) => entry.type === "model_change").length,
		thinkingChanges: entries.filter((entry) => entry.type === "thinking_level_change").length,
	};
}
