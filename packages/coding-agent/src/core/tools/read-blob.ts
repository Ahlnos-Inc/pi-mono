import type { TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import type { SessionBlobStore } from "../session-blob-store.js";

const readBlobSchema = Type.Object({
	id: Type.String({ description: "Blob id from a session-blob:// marker" }),
});

type ReadBlobInput = Static<typeof readBlobSchema>;

export interface ReadBlobToolDetails {
	id: string;
	toolName?: string;
}

export function createReadBlobToolDefinition(
	blobStore: SessionBlobStore,
): ToolDefinition<typeof readBlobSchema, ReadBlobToolDetails | undefined> {
	return {
		name: "ReadBlob",
		label: "ReadBlob",
		description: "Retrieve the full original content stored behind a session-blob:// marker.",
		promptSnippet: "Retrieve a stored full tool output by blob id",
		parameters: readBlobSchema,
		async execute(_toolCallId, { id }: ReadBlobInput) {
			const record = blobStore.read(id);
			if (!record) {
				return {
					content: [{ type: "text", text: `Blob not found: ${id}` }],
					isError: true,
					details: undefined,
				};
			}

			const text =
				record.text ??
				(record.content ?? [])
					.map((item) => {
						if (item.type === "text") return item.text;
						return `[Image content: ${item.mimeType}]`;
					})
					.join("\n");

			return {
				content: [{ type: "text", text } satisfies TextContent],
				details: { id: record.id, toolName: record.toolName },
			};
		},
		renderResult(result, _options, theme, context) {
			const output = context.isError
				? result.content
						.filter((item): item is TextContent => item.type === "text")
						.map((item) => item.text)
						.join("\n")
				: `Loaded blob ${result.details?.id ?? ""}`;
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}
