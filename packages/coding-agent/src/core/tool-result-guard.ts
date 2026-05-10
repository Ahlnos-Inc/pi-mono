import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { BashResult } from "./bash-executor.js";
import type { SessionBlobStore } from "./session-blob-store.js";

export const DEFAULT_TOOL_RESULT_GUARD_SUMMARIZE_OVER = 8000;
export const DEFAULT_TOOL_RESULT_GUARD_SUMMARY_MODEL = "claude-cli/claude-haiku-4-5-20251001";

export interface ToolResultGuardSettings {
	summarizeOver: number;
	summaryModel: string;
}

export interface GuardToolResultOptions {
	toolName: string;
	content: Array<TextContent | ImageContent>;
	details?: unknown;
	settings: ToolResultGuardSettings;
	blobStore: SessionBlobStore;
	summarize: (text: string, metadata: { toolName: string; originalChars: number }) => Promise<string>;
}

export interface GuardedToolResult {
	content: Array<TextContent | ImageContent>;
	details: unknown;
	blobId?: string;
	originalChars: number;
	summary: string;
}

export async function guardToolResultContent(options: GuardToolResultOptions): Promise<GuardedToolResult | undefined> {
	const text = getTextOutput(options.content);
	const originalChars = text.length;
	if (options.settings.summarizeOver <= 0 || originalChars <= options.settings.summarizeOver) {
		return undefined;
	}

	const blob = options.blobStore.write({
		toolName: options.toolName,
		content: options.content,
		details: options.details,
	});
	const summary = await summarizeWithFallback(options.summarize, text, {
		toolName: options.toolName,
		originalChars,
	});

	return {
		content: [
			{
				type: "text",
				text: formatGuardedOutput(summary, blob.id, originalChars),
			},
		],
		details: {
			...(isRecord(options.details) ? options.details : {}),
			toolResultGuard: {
				blobId: blob.id,
				originalChars,
				summarized: true,
			},
		},
		blobId: blob.id,
		originalChars,
		summary,
	};
}

export async function guardBashResult(
	command: string,
	result: BashResult,
	options: Omit<GuardToolResultOptions, "toolName" | "content" | "details">,
): Promise<BashResult> {
	if (options.settings.summarizeOver <= 0 || result.output.length <= options.settings.summarizeOver) {
		return result;
	}

	const blob = options.blobStore.write({
		toolName: "bash",
		text: result.output,
		details: {
			command,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
		},
	});
	const summary = await summarizeWithFallback(options.summarize, result.output, {
		toolName: "bash",
		originalChars: result.output.length,
	});

	return {
		...result,
		output: formatGuardedOutput(summary, blob.id, result.output.length),
		truncated: true,
	};
}

export function getTextOutput(content: Array<TextContent | ImageContent>): string {
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export function formatGuardedOutput(summary: string, blobId: string, originalChars: number): string {
	return [
		`Tool output summary (${originalChars} chars original):`,
		summary.trim(),
		"",
		`[truncated - original at session-blob://${blobId}; use ReadBlob(${blobId}) to retrieve full output]`,
	].join("\n");
}

async function summarizeWithFallback(
	summarize: GuardToolResultOptions["summarize"],
	text: string,
	metadata: { toolName: string; originalChars: number },
): Promise<string> {
	try {
		const summary = (await summarize(text, metadata)).trim();
		if (summary) {
			return summary;
		}
	} catch {}

	const lines = text.split(/\r?\n/);
	const head = lines.slice(0, 40).join("\n").trim();
	return head
		? `Automatic model summary failed. Leading output excerpt:\n${head}`
		: "Automatic model summary failed and the original output was empty after trimming.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
