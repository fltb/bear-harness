import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { ArtifactStore } from "../artifacts/index.js";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import { canonChunks, canonSources, storyModules } from "../storage/schema.js";

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
		private readonly db: AppDatabase,
		private readonly artifacts: ArtifactStore,
		private readonly eventBus: EventBus,
	) {}

	addSource(companionId: string, logicalName: string, content: string): CanonSourceRecord {
		const normalized = content.replaceAll("\r\n", "\n").trim();
		const buffer = Buffer.from(normalized, "utf8");
		const artifact = this.artifacts.create({ logicalName, buffer, mime: "text/plain" });
		const id = randomUUID();
		const chunks = splitCanon(normalized);
		this.db.transaction((transaction) => {
			transaction
				.insert(canonSources)
				.values({
					id,
					companionId,
					logicalName: logicalName.trim(),
					mime: "text/plain",
					sha256: artifact.sha256,
					artifactId: artifact.id,
				})
				.run();
			let offset = 0;
			const values = chunks.map((chunk, ordinal) => {
				const start = normalized.indexOf(chunk, offset);
				const actualStart = start >= 0 ? start : offset;
				offset = actualStart + chunk.length;
				return {
					id: randomUUID(),
					sourceId: id,
					ordinal,
					content: chunk,
					startOffset: actualStart,
					endOffset: actualStart + chunk.length,
					tokenCount: estimateTokens(chunk),
				};
			});
			if (values.length > 0) transaction.insert(canonChunks).values(values).run();
		});
		this.eventBus.publish("canon.source_added", { companionId, sourceId: id, logicalName });
		const source = this.getSource(id);
		if (!source) throw { kind: "internal", reason: "canon_source_not_persisted" };
		return source;
	}

	listSources(companionId: string): CanonSourceRecord[] {
		return this.db
			.select({
				id: canonSources.id,
				logicalName: canonSources.logicalName,
				mime: canonSources.mime,
				sha256: canonSources.sha256,
				createdAt: canonSources.createdAt,
				chunkCount: count(canonChunks.id),
			})
			.from(canonSources)
			.leftJoin(canonChunks, eq(canonChunks.sourceId, canonSources.id))
			.where(eq(canonSources.companionId, companionId))
			.groupBy(canonSources.id)
			.orderBy(desc(canonSources.createdAt))
			.all();
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
		return this.db
			.select({
				id: canonChunks.id,
				sourceId: canonChunks.sourceId,
				sourceName: canonSources.logicalName,
				ordinal: canonChunks.ordinal,
				content: canonChunks.content,
			})
			.from(canonChunks)
			.innerJoin(canonSources, eq(canonSources.id, canonChunks.sourceId))
			.where(
				and(
					eq(canonSources.companionId, companionId),
					or(...terms.map((term) => sql`instr(${canonChunks.content}, ${term}) > 0`)),
				),
			)
			.orderBy(asc(canonChunks.sourceId), asc(canonChunks.ordinal))
			.limit(Math.min(limit, 30))
			.all();
	}

	removeSource(companionId: string, sourceId: string): void {
		const result = this.db
			.delete(canonSources)
			.where(and(eq(canonSources.id, sourceId), eq(canonSources.companionId, companionId)))
			.run();
		if (result.changes === 0) throw { kind: "not_found", reason: "canon_source_not_found" };
		this.eventBus.publish("canon.source_removed", { companionId, sourceId });
	}

	listModules(companionId: string): StoryModuleRecord[] {
		return this.db
			.select()
			.from(storyModules)
			.where(eq(storyModules.companionId, companionId))
			.orderBy(asc(storyModules.createdAt))
			.all()
			.map((row) => ({
				id: row.id,
				...(row.parentId ? { parentId: row.parentId } : {}),
				kind: row.kind,
				title: row.name,
				instructions: row.description,
				sourceChunkIds: row.sourceRefsJson,
				createdAt: row.createdAt,
			}));
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
			.select({ companionId: storyModules.companionId })
			.from(storyModules)
			.where(eq(storyModules.id, id))
			.get();
		if (existing && existing.companionId !== params.companionId) {
			throw { kind: "not_found", reason: "story_module_not_found" };
		}
		if (params.parentId) this.assertValidParent(params.companionId, id, params.parentId);
		const validChunks =
			params.sourceChunkIds.length === 0 ||
			this.db
				.select({ count: count() })
				.from(canonChunks)
				.innerJoin(canonSources, eq(canonSources.id, canonChunks.sourceId))
				.where(
					and(
						eq(canonSources.companionId, params.companionId),
						inArray(canonChunks.id, params.sourceChunkIds),
					),
				)
				.get()?.count === params.sourceChunkIds.length;
		if (!validChunks) throw { kind: "invalid_request", reason: "story_module_chunk_not_found" };
		this.db
			.insert(storyModules)
			.values({
				id,
				companionId: params.companionId,
				parentId: params.parentId ?? null,
				kind: params.kind,
				name: title,
				description: params.instructions.trim(),
				sourceRefsJson: params.sourceChunkIds,
				dependenciesJson: [],
			})
			.onConflictDoUpdate({
				target: storyModules.id,
				set: {
					parentId: params.parentId ?? null,
					kind: params.kind,
					name: title,
					description: params.instructions.trim(),
					sourceRefsJson: params.sourceChunkIds,
				},
			})
			.run();
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
				.select({ companionId: storyModules.companionId, parentId: storyModules.parentId })
				.from(storyModules)
				.where(eq(storyModules.id, currentId))
				.get();
			if (!row || row.companionId !== companionId) {
				throw { kind: "invalid_request", reason: "story_module_parent_not_found" };
			}
			currentId = row.parentId;
		}
	}

	deleteModule(companionId: string, id: string): void {
		this.db
			.update(storyModules)
			.set({ parentId: null })
			.where(and(eq(storyModules.parentId, id), eq(storyModules.companionId, companionId)))
			.run();
		const result = this.db
			.delete(storyModules)
			.where(and(eq(storyModules.id, id), eq(storyModules.companionId, companionId)))
			.run();
		if (result.changes === 0) throw { kind: "not_found", reason: "story_module_not_found" };
		this.eventBus.publish("canon.module_removed", { companionId, moduleId: id });
	}

	private getSource(id: string): CanonSourceRecord | null {
		return (
			this.db
				.select({
					id: canonSources.id,
					logicalName: canonSources.logicalName,
					mime: canonSources.mime,
					sha256: canonSources.sha256,
					createdAt: canonSources.createdAt,
					chunkCount: count(canonChunks.id),
				})
				.from(canonSources)
				.leftJoin(canonChunks, eq(canonChunks.sourceId, canonSources.id))
				.where(eq(canonSources.id, id))
				.groupBy(canonSources.id)
				.get() ?? null
		);
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
