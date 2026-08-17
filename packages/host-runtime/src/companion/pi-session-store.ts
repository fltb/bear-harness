import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	SessionManager,
	type SessionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AppDatabase } from "../storage/database.js";
import { conversationSessions } from "../storage/schema.js";
import { eq } from "drizzle-orm";

import { isAbsolute } from "node:path";

/** The standard user, assistant, and tool-result messages stored by Pi. */
export type PiSessionMessage = Extract<
	AgentMessage,
	{ role: "user" | "assistant" | "toolResult" }
>;

/** The standard Pi message plus its stable SessionManager tree-entry identity. */
export interface PiSessionMessageEntry {
	readonly id: string;
	readonly message: PiSessionMessage;
}

export interface PiSessionStoreOptions {
	/** Product-owned directory in which Pi may create session JSONL files. */
	readonly sessionDir: string;
	/** Existing (or explicitly named new) session file to open. */
	readonly sessionFile?: string;
	/** Working directory recorded in the Pi session header. Defaults to sessionDir. */
	readonly cwd?: string;
}

export interface PiSessionMigrationOptions extends Omit<PiSessionStoreOptions, "sessionFile"> {
	/** Legacy conversation whose adopted history is being migrated. */
	readonly conversationId: string;
	/** Adopted legacy messages, already represented as Pi standard messages. */
	readonly messages: readonly PiSessionMessage[];
	/** Host metadata database; message content is never written to it. */
	readonly db: AppDatabase;
}

export interface PiSessionMetadata {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly leafId: string | null;
}

/**
 * Small Host-side adapter over Pi's persistent SessionManager.
 *
 * SessionManager remains the sole owner of the append-only tree, branch
 * selection, and compaction-aware context reconstruction. This class only
 * supplies the product-owned storage location and projects the small surface
 * needed by the Host.
 *
 * Persistence follows Pi's append-only contract: a user entry may remain an
 * active runtime-only tail until an assistant entry is appended. Callers
 * reopening the session before assistant completion must recover that tail
 * from the Host's pending-turn state; this wrapper does not write a parallel
 * session file.
 */
export class PiSessionStore {
	private readonly manager: SessionManager;

	constructor(options: PiSessionStoreOptions) {
		const sessionDir = absolutePath(options.sessionDir, "sessionDir");
		const cwd = absolutePath(options.cwd ?? sessionDir, "cwd");
		const sessionFile = options.sessionFile
			? absolutePath(options.sessionFile, "sessionFile")
			: undefined;

		this.manager = sessionFile
			? SessionManager.open(sessionFile, sessionDir, cwd)
			: SessionManager.create(cwd, sessionDir);
		if (!this.manager.isPersisted()) {
			throw new Error("Pi session store requires a persistent SessionManager");
		}
	}

	/**
	 * Create a new persistent session in the supplied product data directory.
	 *
	 * Pi keeps a user-only active tail in the live SessionManager until an
	 * assistant entry is appended; recover it from Host pending-turn state if
	 * the session is reopened before assistant completion.
	 */
	static create(options: Omit<PiSessionStoreOptions, "sessionFile">): PiSessionStore {
		return new PiSessionStore(options);
	}

	/**
	 * Open an existing materialized session file, or initialize that explicit
	 * file if new. A user-only tail that has not yet been followed by an
	 * assistant entry is not recoverable from this reopen and belongs in the
	 * Host's pending-turn state.
	 */
	static open(options: PiSessionStoreOptions & { sessionFile: string }): PiSessionStore {
		return new PiSessionStore(options);
	}

	/**
	 * Import one legacy conversation's adopted Pi messages once.
	 *
	 * The Host database is used only for the conversation-to-session
	 * projection. Message content is appended to SessionManager and never
	 * copied into SQLite. Pi intentionally defers writing a new session file
	 * until its first assistant entry, so a user-only migrated tail remains
	 * in the live SessionManager until that response is appended.
	 */
	static migrateLegacyConversation(options: PiSessionMigrationOptions): PiSessionMetadata {
		const existing = options.db
			.select({
				sessionId: conversationSessions.piSessionId,
				sessionFile: conversationSessions.sessionFilePath,
				leafId: conversationSessions.activeLeafId,
			})
			.from(conversationSessions)
			.where(eq(conversationSessions.conversationId, options.conversationId))
			.get();
		if (existing) {
			return {
				sessionId: existing.sessionId,
				sessionFile: existing.sessionFile,
				leafId: existing.leafId,
			};
		}

		const store = PiSessionStore.create(options);
		for (const message of options.messages) store.appendMessage(message);
		const metadata = store.metadata;
		options.db
			.insert(conversationSessions)
			.values({
				conversationId: options.conversationId,
				piSessionId: metadata.sessionId,
				sessionFilePath: metadata.sessionFile,
				activeLeafId: metadata.leafId,
			})
			.run();
		return metadata;
	}

	get sessionId(): string {
		return this.manager.getSessionId();
	}

	get sessionFile(): string {
		return requireSessionFile(this.manager.getSessionFile());
	}

	get leafId(): string | null {
		return this.manager.getLeafId();
	}

	get currentLeaf(): SessionEntry | undefined {
		return this.manager.getLeafEntry();
	}

	get metadata(): PiSessionMetadata {
		return {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			leafId: this.leafId,
		};
	}

	/**
	 * Append one standard Pi message below the current leaf.
	 *
	 * Pi's SessionManager only materializes the append-only persistent session
	 * after an assistant entry is appended. A user-only active tail therefore
	 * remains runtime-only; callers must recover it through the Host's
	 * pending-turn state until assistant completion.
	 */
	appendMessage(message: PiSessionMessage): string {
		return this.manager.appendMessage(message);
	}

	/** Read standard message entries and preserve each SessionManager entry id. */
	readMessageEntries(): PiSessionMessageEntry[] {
		return this.manager
			.getBranch()
			.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
			.flatMap((entry) => (isStandardMessage(entry.message) ? [{ id: entry.id, message: entry.message }] : []));
	}

	/** Read standard message entries on the currently selected branch. */
	readMessages(): PiSessionMessage[] {
		return this.readMessageEntries().map(({ message }) => message);
	}

	/** Move Pi's active leaf; the next append creates a new child branch. */
	selectBranch(leafId: string): void {
		this.manager.branch(leafId);
	}

	/** Reconstruct the active, compaction-aware context through Pi. */
	buildContext(): SessionContext {
		return this.manager.buildSessionContext();
	}
}

function absolutePath(value: string, name: string): string {
	if (!isAbsolute(value)) {
		throw new Error(`Pi ${name} must be an absolute path`);
	}
	return value;
}

function requireSessionFile(path: string | undefined): string {
	if (!path) throw new Error("Pi SessionManager did not provide a session file");
	return path;
}

function isStandardMessage(message: AgentMessage): message is PiSessionMessage {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}
