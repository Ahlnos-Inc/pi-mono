export type SessionResourceCleanup = (sessionId?: string) => void | Promise<void>;

const sessionResourceCleanups = new Set<SessionResourceCleanup>();

export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	sessionResourceCleanups.add(cleanup);
	return () => {
		sessionResourceCleanups.delete(cleanup);
	};
}

export async function cleanupSessionResources(sessionId?: string): Promise<void> {
	const errors: unknown[] = [];
	for (const cleanup of sessionResourceCleanups) {
		try {
			await cleanup(sessionId);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "Failed to cleanup session resources");
	}
}
