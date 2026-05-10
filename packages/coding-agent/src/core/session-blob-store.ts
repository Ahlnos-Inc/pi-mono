import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionManager } from "./session-manager.js";

export interface SessionBlobRecord {
	id: string;
	createdAt: string;
	toolName?: string;
	content?: Array<TextContent | ImageContent>;
	text?: string;
	details?: unknown;
}

export class SessionBlobStore {
	constructor(private readonly sessionManager: SessionManager) {}

	write(record: Omit<SessionBlobRecord, "id" | "createdAt">): SessionBlobRecord {
		const id = randomUUID();
		const fullRecord: SessionBlobRecord = {
			id,
			createdAt: new Date().toISOString(),
			...record,
		};
		const dir = this.getBlobDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(this.getBlobPath(id), JSON.stringify(fullRecord, null, 2), "utf-8");
		return fullRecord;
	}

	read(id: string): SessionBlobRecord | undefined {
		if (!/^[0-9a-f-]{36}$/i.test(id)) {
			return undefined;
		}
		const path = this.getBlobPath(id);
		if (!existsSync(path)) {
			return undefined;
		}
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as SessionBlobRecord;
		return parsed.id === id ? parsed : undefined;
	}

	private getBlobDir(): string {
		return join(this.sessionManager.getSessionDir(), "blobs", this.sessionManager.getSessionId());
	}

	private getBlobPath(id: string): string {
		return join(this.getBlobDir(), `${id}.json`);
	}
}
