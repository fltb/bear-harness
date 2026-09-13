import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { nativeCapabilities } from "../native/capabilities.js";
import { listLocalProfiles } from "./profile/profile-sync.js";
import { LOCAL_MEMORY_DATABASE_FILENAME } from "./store/factory.js";

export interface MemoryInspectionItem {
	id: string;
	type: string;
	content: string;
	sceneName: string;
	createdAt: string;
	updatedAt: string;
	sessionId?: string;
}

export interface MemoryInspectionPage {
	items: MemoryInspectionItem[];
	nextOffset?: number;
}

/** Reads TDAI's persisted local records, without embeddings, extraction, or store initialization. */
export async function inspectLocalMemory(
	dataDir: string,
	request: { kind: "records" | "profiles"; offset: number; limit: number },
): Promise<MemoryInspectionPage> {
	const { offset, limit } = request;
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 25) {
		throw new TypeError("Invalid memory page");
	}
	let root: string;
	try {
		root = await realpath(dataDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
		throw error;
	}
	if (request.kind === "profiles") {
		const page = await listLocalProfiles(root, { offset, limit });
		return {
			items: page.profiles.map((profile) => ({
				id: profile.id,
				type: profile.type,
				content: profile.content,
				sceneName: profile.filename,
				createdAt: new Date(profile.createdAtMs).toISOString(),
				updatedAt: new Date(profile.updatedAtMs).toISOString(),
			})),
			...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
		};
	}
	const filename = path.join(root, LOCAL_MEMORY_DATABASE_FILENAME);
	try {
		const stat = await lstat(filename);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe memory database");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
		throw error;
	}
	for (const suffix of ["-wal", "-shm"]) {
		try {
			if ((await lstat(`${filename}${suffix}`)).isSymbolicLink()) throw new Error("Unsafe memory database sidecar");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const { DatabaseSync } = nativeCapabilities.requireNodeSqlite();
	const database = new DatabaseSync(filename, { readOnly: true });
	try {
		database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000;");
		const rows = database.prepare(`
			SELECT record_id AS id, type,
				CASE WHEN length(content) <= 262144 THEN content ELSE NULL END AS content,
				scene_name AS sceneName, created_time AS createdAt, updated_time AS updatedAt,
				session_id AS sessionId
			FROM l1_records ORDER BY updated_time DESC, record_id DESC LIMIT ? OFFSET ?
		`).all(limit + 1, offset) as unknown as MemoryInspectionItem[];
		if (rows.some((row) => row.content === null)) throw new Error("Memory record exceeds read limit");
		return {
			items: rows.slice(0, limit),
			...(rows.length > limit ? { nextOffset: offset + limit } : {}),
		};
	} finally {
		database.close();
	}
}
