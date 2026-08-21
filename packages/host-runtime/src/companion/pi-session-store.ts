import { isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type SessionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { conversationSessions } from "../storage/schema.js";

/** The standard user, assistant, and tool-result messages stored by Pi. */
export type PiSessionMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

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

	/** The canonical public SessionManager used by the native Pi session runtime. */
	get sessionManager(): SessionManager {
		return this.manager;
	}

	get cwd(): string {
		return this.manager.getCwd();
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
	/** Find the newest standard message with matching role/content. */
	findMessageEntry(
		role: "user" | "assistant",
		content: string,
		options: { branchOnly?: boolean } = {},
	): PiSessionMessageEntry | undefined {
		const entries = options.branchOnly ? this.manager.getBranch() : this.manager.getEntries();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (!entry || entry.type !== "message" || !isStandardMessage(entry.message)) continue;
			if (entry.message.role !== role || sessionMessageText(entry.message) !== content) continue;
			return { id: entry.id, message: entry.message };
		}
		return undefined;
	}
	/** Return a standard message entry by its public SessionManager entry ID. */
	getMessageEntry(entryId: string): PiSessionMessageEntry | undefined {
		const entry = this.manager.getEntry(entryId);
		if (!entry || entry.type !== "message" || !isStandardMessage(entry.message)) return undefined;
		return { id: entry.id, message: entry.message };
	}
	/** Return whether an entry belongs to the currently selected Pi branch. */
	isEntryOnCurrentBranch(entryId: string): boolean {
		return this.manager.getBranch().some((entry) => entry.id === entryId);
	}

	/** Return the nearest user message preceding a message entry on its Pi branch. */
	findParentUserEntry(entryId: string): PiSessionMessageEntry | undefined {
		const branch = this.manager.getBranch(entryId);
		for (let index = branch.length - 2; index >= 0; index -= 1) {
			const entry = branch[index];
			if (
				entry?.type === "message" &&
				isStandardMessage(entry.message) &&
				entry.message.role === "user"
			) {
				return { id: entry.id, message: entry.message };
			}
		}
		return undefined;
	}

	/**
	 * Select the path immediately before an entry. The next append therefore
	 * creates a sibling of that entry while SessionManager retains the tree.
	 */
	branchBefore(entryId: string): void {
		const path = this.manager.getBranch(entryId);
		if (path.length === 0 || path.at(-1)?.id !== entryId) {
			throw new Error(`Entry ${entryId} not found`);
		}
		const parent = path.at(-2);
		if (parent) this.manager.branch(parent.id);
		else this.manager.resetLeaf();
	}

	/** Append a host-authored assistant reply as a native Pi message entry. */
	appendSyntheticAssistant(text: string): string {
		const message: PiSessionMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "host",
			model: "host-edit",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		return this.manager.appendMessage(message);
	}

	/** Append a user message through the canonical SessionManager. */
	appendUserMessage(text: string, timestamp = Date.now()): string {
		return this.manager.appendMessage({ role: "user", content: text, timestamp });
	}

	/** Read standard message entries and preserve each SessionManager entry id. */
	readMessageEntries(): PiSessionMessageEntry[] {
		return this.manager
			.getBranch()
			.filter(
				(entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message",
			)
			.flatMap((entry) =>
				isStandardMessage(entry.message) ? [{ id: entry.id, message: entry.message }] : [],
			);
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
	/**
	 * Append Pi's native compaction entry below the selected leaf.
	 *
	 * Summary generation is intentionally owned by Pi's compaction runtime;
	 * this adapter only forwards the public SessionManager operation so the
	 * resulting context remains branch-local and SessionManager-owned.
	 */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Parameters<SessionManager["appendCompaction"]>[5],
	): string {
		return this.manager.appendCompaction(
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
			usage,
		);
	}

	/** Build the selected branch's native, compaction-aware entry path. */
	buildContextEntries(): SessionEntry[] {
		return this.manager.buildContextEntries();
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

const HOST_CONTEXT_PREFIX = "<host_context>\n";
const HOST_CONTEXT_SEPARATOR = "\n</host_context>\n\n<current_user_message>\n";
const CURRENT_USER_MESSAGE_SUFFIX = "\n</current_user_message>";

function sessionMessageText(message: PiSessionMessage): string {
	const content = sessionMessageContent(message);
	if (message.role === "user") {
		const projected = extractCurrentUserMessage(content);
		if (projected !== undefined) return projected;
	}
	return content.trim();
}

function sessionMessageContent(message: PiSessionMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => {
			if (
				!part ||
				typeof part !== "object" ||
				!("type" in part) ||
				!("text" in part) ||
				part.type !== "text" ||
				typeof part.text !== "string"
			) {
				return "";
			}
			return part.text;
		})
		.filter(Boolean)
		.join("\n");
}

function extractCurrentUserMessage(content: string): string | undefined {
	if (!content.startsWith(HOST_CONTEXT_PREFIX) || !content.endsWith(CURRENT_USER_MESSAGE_SUFFIX)) {
		return undefined;
	}
	const separatorIndex = content.indexOf(HOST_CONTEXT_SEPARATOR, HOST_CONTEXT_PREFIX.length);
	if (separatorIndex <= HOST_CONTEXT_PREFIX.length) return undefined;
	return content.slice(
		separatorIndex + HOST_CONTEXT_SEPARATOR.length,
		-CURRENT_USER_MESSAGE_SUFFIX.length,
	);
}

function isStandardMessage(message: AgentMessage): message is PiSessionMessage {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}
