import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	SessionManager,
	type SessionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";

/** The standard user, assistant, and tool-result messages stored by Pi. */
export type PiSessionMessage = Extract<
	AgentMessage,
	{ role: "user" | "assistant" | "toolResult" }
>;

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

	/** Create a new persistent session in the supplied product data directory. */
	static create(options: Omit<PiSessionStoreOptions, "sessionFile">): PiSessionStore {
		return new PiSessionStore(options);
	}

	/** Open an existing session file, or initialize that explicit file if new. */
	static open(options: PiSessionStoreOptions & { sessionFile: string }): PiSessionStore {
		return new PiSessionStore(options);
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

	/** Append one standard Pi message below the current leaf. */
	appendMessage(message: PiSessionMessage): string {
		return this.manager.appendMessage(message);
	}

	/** Read standard message entries on the currently selected branch. */
	readMessages(): PiSessionMessage[] {
		return this.manager
			.getBranch()
			.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
			.map((entry) => entry.message)
			.filter(isStandardMessage);
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
