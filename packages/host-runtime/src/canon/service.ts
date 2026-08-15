import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactStore } from "../artifacts/index.js";
import type { EventBus } from "../storage/event-bus.js";

export interface CanonSourceRecord {
	id: string;
	logicalName: string;
	mime: string;
	sha256: string;
	chunkCount: number;
	createdAt: string;
}

export interface CanonChunkRecord {
	id: string;
	sourceId: string;
	sourceName: string;
	ordinal: number;
	content: string;
}

export interface StoryModuleRecord {
	id: string;
	parentId?: string;
	kind: "root" | "arc" | "event" | "entity" | "relationship" | "location" | "object" | "behavior";
	title: string;
	instructions: string;
	sourceChunkIds: string[];
	createdAt: string;
}

const MAX_CHUNK_CHARS = 1600;

export class CanonHubService {
	constructor(
		private readonly db: DatabaseSync,
		private readonly artifacts: ArtifactStore,
		private readonly eventBus: EventBus,
	) {}

	addSource(companionId: string, logicalName: string, content: string): CanonSourceRecord {
		const normalized = content.replaceAll("\r\n", "\n").trim();
		const buffer = Buffer.from(normalized, "utf8");
		const artifact = this.artifacts.create({ logicalName, buffer, mime: "text/plain" });
		const id = randomUUID();
		const chunks = splitCanon(normalized);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					"INSERT INTO canon_sources (id, companion_id, logical_name, mime, sha256, artifact_id) VALUES (?, ?, ?, 'text/plain', ?, ?)",
				)
				.run(id, companionId, logicalName.trim(), artifact.sha256, artifact.id);
			const insert = this.db.prepare(
				"INSERT INTO canon_chunks (id, source_id, ordinal, content, start_offset, end_offset, token_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			let offset = 0;
			chunks.forEach((chunk, ordinal) => {
				const start = normalized.indexOf(chunk, offset);
				const actualStart = start >= 0 ? start : offset;
				insert.run(
					randomUUID(),
					id,
					ordinal,
					chunk,
					actualStart,
					actualStart + chunk.length,
					estimateTokens(chunk),
				);
				offset = actualStart + chunk.length;
			});
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		this.eventBus.publish("canon.source_added", { companionId, sourceId: id, logicalName });
		const source = this.getSource(id);
		if (!source) throw { kind: "internal", reason: "canon_source_not_persisted" };
		return source;
	}

	listSources(companionId: string): CanonSourceRecord[] {
		return (
			this.db
				.prepare(
					`SELECT cs.id, cs.logical_name, cs.mime, cs.sha256, cs.created_at, COUNT(cc.id) AS chunk_count
			 FROM canon_sources cs LEFT JOIN canon_chunks cc ON cc.source_id = cs.id
			 WHERE cs.companion_id = ? GROUP BY cs.id ORDER BY cs.created_at DESC`,
				)
				.all(companionId) as Array<Record<string, unknown>>
		).map(sourceRecord);
	}

	search(companionId: string, query: string, limit = 12): CanonChunkRecord[] {
		const terms = [
			...new Set(
				query
					.trim()
					.split(/[\s，。！？；、]+/)
					.filter((term) => term.length >= 2),
			),
		].slice(0, 8);
		if (terms.length === 0) return [];
		const clauses = terms.map(() => "cc.content LIKE ?").join(" OR ");
		const params = terms.map((term) => `%${term}%`);
		return (
			this.db
				.prepare(
					`SELECT cc.id, cc.source_id, cs.logical_name, cc.ordinal, cc.content
			 FROM canon_chunks cc JOIN canon_sources cs ON cs.id = cc.source_id
			 WHERE cs.companion_id = ? AND (${clauses})
			 ORDER BY cc.source_id, cc.ordinal LIMIT ?`,
				)
				.all(companionId, ...params, Math.min(limit, 30)) as Array<Record<string, unknown>>
		).map(chunkRecord);
	}

	removeSource(companionId: string, sourceId: string): void {
		const result = this.db
			.prepare("DELETE FROM canon_sources WHERE id = ? AND companion_id = ?")
			.run(sourceId, companionId);
		if (result.changes === 0) throw { kind: "not_found", reason: "canon_source_not_found" };
		this.eventBus.publish("canon.source_removed", { companionId, sourceId });
	}

	listModules(companionId: string): StoryModuleRecord[] {
		return (
			this.db
				.prepare(
					"SELECT id, parent_id, kind, name, description, source_refs_json, created_at FROM story_modules WHERE companion_id = ? ORDER BY created_at",
				)
				.all(companionId) as Array<Record<string, unknown>>
		).map(moduleRecord);
	}

	upsertModule(params: {
		companionId: string;
		id?: string;
		parentId?: string;
		kind: StoryModuleRecord["kind"];
		title: string;
		instructions: string;
		sourceChunkIds: string[];
	}): StoryModuleRecord {
		const id = params.id ?? randomUUID();
		const title = params.title.trim();
		if (!title) throw { kind: "invalid_request", reason: "story_module_title_empty" };
		const existing = this.db
			.prepare("SELECT companion_id FROM story_modules WHERE id = ?")
			.get(id) as { companion_id: string } | undefined;
		if (existing && existing.companion_id !== params.companionId) {
			throw { kind: "not_found", reason: "story_module_not_found" };
		}
		if (params.parentId) this.assertValidParent(params.companionId, id, params.parentId);
		const validChunks =
			params.sourceChunkIds.length === 0 ||
			(
				this.db
					.prepare(
						`SELECT COUNT(*) AS count FROM canon_chunks cc JOIN canon_sources cs ON cs.id = cc.source_id
			 WHERE cs.companion_id = ? AND cc.id IN (${params.sourceChunkIds.map(() => "?").join(",")})`,
					)
					.get(params.companionId, ...params.sourceChunkIds) as { count: number }
			).count === params.sourceChunkIds.length;
		if (!validChunks) throw { kind: "invalid_request", reason: "story_module_chunk_not_found" };
		this.db
			.prepare(
				`INSERT INTO story_modules (id, companion_id, parent_id, kind, name, description, source_refs_json, dependencies_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, '[]')
			 ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, kind=excluded.kind,
			 name=excluded.name, description=excluded.description, source_refs_json=excluded.source_refs_json`,
			)
			.run(
				id,
				params.companionId,
				params.parentId ?? null,
				params.kind,
				title,
				params.instructions.trim(),
				JSON.stringify(params.sourceChunkIds),
			);
		this.eventBus.publish("canon.module_saved", { companionId: params.companionId, moduleId: id });
		const saved = this.listModules(params.companionId).find((module) => module.id === id);
		if (!saved) throw { kind: "internal", reason: "story_module_not_persisted" };
		return saved;
	}

	private assertValidParent(companionId: string, moduleId: string, parentId: string): void {
		if (parentId === moduleId)
			throw { kind: "invalid_request", reason: "story_module_cannot_parent_itself" };
		let currentId: string | null = parentId;
		const visited = new Set<string>();
		while (currentId) {
			if (currentId === moduleId || visited.has(currentId)) {
				throw { kind: "invalid_request", reason: "story_module_parent_cycle" };
			}
			visited.add(currentId);
			const row = this.db
				.prepare("SELECT companion_id, parent_id FROM story_modules WHERE id = ?")
				.get(currentId) as { companion_id: string; parent_id: string | null } | undefined;
			if (!row || row.companion_id !== companionId) {
				throw { kind: "invalid_request", reason: "story_module_parent_not_found" };
			}
			currentId = row.parent_id;
		}
	}

	deleteModule(companionId: string, id: string): void {
		this.db
			.prepare("UPDATE story_modules SET parent_id = NULL WHERE parent_id = ? AND companion_id = ?")
			.run(id, companionId);
		const result = this.db
			.prepare("DELETE FROM story_modules WHERE id = ? AND companion_id = ?")
			.run(id, companionId);
		if (result.changes === 0) throw { kind: "not_found", reason: "story_module_not_found" };
		this.eventBus.publish("canon.module_removed", { companionId, moduleId: id });
	}

	private getSource(id: string): CanonSourceRecord | null {
		const row = this.db
			.prepare(
				`SELECT cs.id, cs.logical_name, cs.mime, cs.sha256, cs.created_at, COUNT(cc.id) AS chunk_count
			 FROM canon_sources cs LEFT JOIN canon_chunks cc ON cc.source_id = cs.id WHERE cs.id = ? GROUP BY cs.id`,
			)
			.get(id) as Record<string, unknown> | undefined;
		return row ? sourceRecord(row) : null;
	}
}

function splitCanon(content: string): string[] {
	const paragraphs = content
		.split(/\n{2,}/)
		.map((part) => part.trim())
		.filter(Boolean);
	const chunks: string[] = [];
	let current = "";
	for (const paragraph of paragraphs) {
		if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
			chunks.push(current);
			current = "";
		}
		if (paragraph.length <= MAX_CHUNK_CHARS)
			current = current ? `${current}\n\n${paragraph}` : paragraph;
		else
			for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARS)
				chunks.push(paragraph.slice(offset, offset + MAX_CHUNK_CHARS));
	}
	if (current) chunks.push(current);
	return chunks;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}
function sourceRecord(row: Record<string, unknown>): CanonSourceRecord {
	return {
		id: String(row.id),
		logicalName: String(row.logical_name),
		mime: String(row.mime),
		sha256: String(row.sha256),
		chunkCount: Number(row.chunk_count),
		createdAt: String(row.created_at),
	};
}
function chunkRecord(row: Record<string, unknown>): CanonChunkRecord {
	return {
		id: String(row.id),
		sourceId: String(row.source_id),
		sourceName: String(row.logical_name),
		ordinal: Number(row.ordinal),
		content: String(row.content),
	};
}
function moduleRecord(row: Record<string, unknown>): StoryModuleRecord {
	let ids: string[] = [];
	try {
		const parsed = JSON.parse(String(row.source_refs_json));
		if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string");
	} catch {}
	return {
		id: String(row.id),
		...(row.parent_id ? { parentId: String(row.parent_id) } : {}),
		kind: row.kind as StoryModuleRecord["kind"],
		title: String(row.name),
		instructions: String(row.description),
		sourceChunkIds: ids,
		createdAt: String(row.created_at),
	};
}
