import { readFileSync } from "node:fs";
import type { TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import type { Skill } from "../skills.js";

const loadSkillSchema = Type.Object({
	name: Type.String({ description: "Skill name exactly as shown in the available skills catalog" }),
});

type LoadSkillInput = Static<typeof loadSkillSchema>;

export interface LoadSkillToolDetails {
	name: string;
	location: string;
	baseDir: string;
}

export function createLoadSkillToolDefinition(
	getSkills: () => Skill[],
): ToolDefinition<typeof loadSkillSchema, LoadSkillToolDetails | undefined> {
	return {
		name: "LoadSkill",
		label: "LoadSkill",
		description: "Load the full SKILL.md instructions for an available skill by name.",
		promptSnippet: "Load full skill instructions by name",
		promptGuidelines: ["Use LoadSkill before applying a listed skill."],
		parameters: loadSkillSchema,
		async execute(_toolCallId, { name }: LoadSkillInput) {
			const skill = getSkills().find((candidate) => candidate.name === name);
			if (!skill) {
				return {
					content: [{ type: "text", text: `Skill not found: ${name}` }],
					isError: true,
					details: undefined,
				};
			}

			const content = readFileSync(skill.filePath, "utf-8");
			const text = [
				`<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.filePath)}">`,
				`References are relative to ${skill.baseDir}.`,
				"",
				content.trim(),
				"</skill>",
			].join("\n");

			return {
				content: [{ type: "text", text } satisfies TextContent],
				details: {
					name: skill.name,
					location: skill.filePath,
					baseDir: skill.baseDir,
				},
			};
		},
		renderResult(result, _options, theme, context) {
			const text = context.isError
				? result.content
						.filter((item): item is TextContent => item.type === "text")
						.map((item) => item.text)
						.join("\n")
				: `Loaded skill ${result.details?.name ?? ""}`;
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	};
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
