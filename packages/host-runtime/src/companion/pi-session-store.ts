import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { PiTimeline, PiTimelineEntry } from "@bear-harness/protocol/schema";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type SessionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

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
 * The session header is materialized before Companion starts using the store,
 * so every native entry appended afterward is durable even when the active
 * tail contains only a user message.
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

	/** Create a persistent session that must be materialized before its first append. */
	static create(options: Omit<PiSessionStoreOptions, "sessionFile">): PiSessionStore {
		return new PiSessionStore(options);
	}

	/** Open an existing materialized session file, or initialize its explicit path. */
	static open(options: PiSessionStoreOptions & { sessionFile: string }): PiSessionStore {
		return new PiSessionStore(options);
	}

	/** Fork a new persistent Pi session containing the source path through one entry. */
	static forkAt(
		options: PiSessionStoreOptions & { sessionFile: string; entryId: string },
	): PiSessionStore {
		const source = new PiSessionStore(options);
		if (!source.manager.getBranch(options.entryId).some((entry) => entry.id === options.entryId)) {
			throw new Error(`Entry ${options.entryId} not found`);
		}
		const forkedFile = source.manager.createBranchedSession(options.entryId);
		return new PiSessionStore({
			sessionDir: options.sessionDir,
			cwd: options.cwd,
			sessionFile: forkedFile,
		});
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

	/** Stable native entry ids on the branch ending at the requested entry. */
	entryPathIds(entryId: string): string[] {
		return this.manager.getBranch(entryId).map((entry) => entry.id);
	}

	get metadata(): PiSessionMetadata {
		return {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			leafId: this.leafId,
		};
	}

	/**
	 * Materialize Pi's session header before the first native entry is appended.
	 *
	 * SessionManager otherwise defers creating a new session file until the
	 * first assistant message. Reopening during a user-only tail would then
	 * lose both the native user entry and its stable entry id.
	 */
	materialize(): void {
		const sessionFile = this.sessionFile;
		if (existsSync(sessionFile)) return;
		if (this.manager.getEntries().length > 0) {
			throw new Error("Pi session must be materialized before its first entry");
		}
		const header = this.manager.getHeader();
		if (!header) throw new Error("Pi session header is missing");
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
		this.manager.setSessionFile(sessionFile);
	}

	/** Append one durable standard Pi message below the current leaf. */
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

	/** Read Pi's active, compaction-aware entry projection with stable entry IDs. */
	readMessageEntries(): PiSessionMessageEntry[] {
		return this.manager
			.buildContextEntries()
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
	/** Project Pi's selected branch directly into the security-safe wire timeline. */
	buildPiTimeline(): PiTimeline {
		const entries = this.manager.buildContextEntries().flatMap((entry) => {
			const projected = projectPiTimelineEntry(entry);
			return projected ? [projected] : [];
		});
		return {
			entries,
			...(this.leafId ? { activeLeafId: this.leafId } : {}),
		};
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
function projectPiTimelineEntry(entry: SessionEntry): PiTimelineEntry | undefined {
	const base = {
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
	};
	if (entry.type === "message") {
		if (!isStandardMessage(entry.message)) return undefined;
		if (entry.message.role === "user") {
			return { ...base, kind: "message", role: "user", text: sessionMessageText(entry.message) };
		}
		if (entry.message.role === "toolResult") {
			const domainFailed = toolResultDomainFailed(entry.message);
			return {
				...base,
				kind: "message",
				role: "tool",
				toolName: entry.message.toolName,
				toolCallId: entry.message.toolCallId,
				status: entry.message.isError || domainFailed ? "failed" : "succeeded",
			};
		}
		const toolCalls = Array.isArray(entry.message.content)
			? entry.message.content.flatMap((part) => {
					if (
						!part ||
						typeof part !== "object" ||
						!("type" in part) ||
						part.type !== "toolCall" ||
						!("name" in part) ||
						typeof part.name !== "string" ||
						!("id" in part) ||
						typeof part.id !== "string"
					) {
						return [];
					}
					return [{ toolName: part.name, toolCallId: part.id }];
				})
			: [];
		const text = sessionMessageText(entry.message);
		const stopReason = entry.message.stopReason;
		return {
			...base,
			kind: "message",
			role: "assistant",
			...(text ? { text } : {}),
			...(toolCalls.length > 0 ? { toolCalls } : {}),
			...(stopReason === "stop" ||
			stopReason === "length" ||
			stopReason === "toolUse" ||
			stopReason === "error" ||
			stopReason === "aborted" ||
			stopReason === "deferred"
				? { stopReason }
				: {}),
			...(typeof entry.message.errorMessage === "string"
				? { errorMessage: entry.message.errorMessage.slice(0, 4096) }
				: {}),
		};
	}
	if (entry.type === "custom_message" && entry.customType === "host_pending_turn") {
		return undefined;
	}
	if (
		entry.type === "thinking_level_change" ||
		entry.type === "model_change" ||
		entry.type === "compaction" ||
		entry.type === "branch_summary" ||
		entry.type === "custom" ||
		entry.type === "custom_message" ||
		entry.type === "label" ||
		entry.type === "session_info"
	) {
		return { ...base, kind: entry.type };
	}
	return undefined;
}

/** Host tools return a structured domain result even when transport execution succeeded. */
function toolResultDomainFailed(message: PiSessionMessage): boolean {
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return false;
	for (const part of message.content) {
		if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") continue;
		if (!("text" in part) || typeof part.text !== "string") continue;
		try {
			const value: unknown = JSON.parse(part.text);
			if (typeof value === "object" && value !== null && "ok" in value && value.ok === false)
				return true;
		} catch {
			// Non-JSON tool output is valid and has no Host domain status.
		}
	}
	return false;
}

function isStandardMessage(message: AgentMessage): message is PiSessionMessage {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}
