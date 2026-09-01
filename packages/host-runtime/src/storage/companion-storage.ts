import { readdirSync } from "node:fs";
import {
	COMPANION_SCHEMA_SQL,
	CompanionDatabase,
	SYSTEM_SCHEMA_SQL,
	SystemDatabase,
} from "./database.js";
import { type CompanionPaths, RuntimeLayout, requireCompanionId } from "./layout.js";

export interface CompanionStorageHandle {
	readonly paths: CompanionPaths;
	readonly database: CompanionDatabase;
}

/** Owns physical database handles only; it contains no Pi or conversation runtime state. */
export class CompanionStorageRegistry {
	readonly layout: RuntimeLayout;
	readonly system: SystemDatabase;
	private readonly handles = new Map<string, CompanionStorageHandle>();
	private closed = false;

	constructor(dataRoot: string) {
		this.layout = new RuntimeLayout(dataRoot);
		this.layout.ensureSystemDirectories();
		this.system = new SystemDatabase(this.layout.systemDatabase);
		this.system.initialize(SYSTEM_SCHEMA_SQL);
	}

	open(companionId: string): CompanionStorageHandle {
		if (this.closed) throw new Error("companion storage registry is closed");
		const id = requireCompanionId(companionId);
		const existing = this.handles.get(id);
		if (existing) return existing;
		const paths = this.layout.ensureCompanionDirectories(id);
		const database = new CompanionDatabase(paths.database, id);
		try {
			database.initialize(COMPANION_SCHEMA_SQL);
			database.ensureRuntimeIdentity();
		} catch (error) {
			database.close();
			throw error;
		}
		const handle = Object.freeze({ paths, database });
		this.handles.set(id, handle);
		return handle;
	}

	peek(companionId: string): CompanionStorageHandle | undefined {
		return this.handles.get(requireCompanionId(companionId));
	}

	closeCompanion(companionId: string): void {
		const id = requireCompanionId(companionId);
		const handle = this.handles.get(id);
		if (!handle) return;
		this.handles.delete(id);
		handle.database.close();
	}

	hasCompanionRuntime(companionId: string): boolean {
		return this.layout.hasCompanionRuntime(companionId);
	}

	deleteCompanionRuntime(companionId: string): boolean {
		const id = requireCompanionId(companionId);
		this.closeCompanion(id);
		return this.layout.removeCompanionRuntime(id);
	}

	forEachCompanionDatabase(visit: (database: CompanionDatabase["orm"]) => void): void {
		for (const entry of readdirSync(this.layout.companionsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const id = requireCompanionId(entry.name);
			const existing = this.handles.get(id);
			const handle = existing ?? this.open(id);
			try {
				visit(handle.database.orm);
			} finally {
				if (!existing) this.closeCompanion(id);
			}
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const handle of this.handles.values()) handle.database.close();
		this.handles.clear();
		this.system.close();
	}
}
