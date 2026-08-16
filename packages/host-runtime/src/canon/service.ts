import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { ArtifactStore } from "../artifacts/index.js";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import {
	canonChunks,
	canonEntities,
	canonPackageState,
	canonSources,
	storyModules,
} from "../storage/schema.js";
import type { LoadedCanonPackage } from "./package-schema.js";

export interface CanonSourceRecord {
	id: string;
	logicalName: string;
	mime: string;
	sha256: string;
	chunkCount: number;
	createdAt: string;
	origin: "user" | "package";
	language: string | null;
	sourceKind: string | null;
}

export interface CanonChunkRecord {
	id: string;
	sourceId: string;
	sourceName: string;
	ordinal: number;
	content: string;
	heading?: string;
	startOffset: number;
	endOffset: number;
	score?: number;
	adjacent?: boolean;
	language?: string;
	origin: "user" | "package";
}

export interface StoryModuleRecord {
	id: string;
	parentId?: string;
	kind: "root" | "arc" | "event" | "entity" | "relationship" | "location" | "object" | "behavior";
	title: string;
	instructions: string;
	sourceChunkIds: string[];
	createdAt: string;
	origin: "user" | "package";
	stableKey?: string;
	triggers: string[];
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
				const start = normalized.indexOf(chunk.content, offset);
				const actualStart = start >= 0 ? start : offset;
				offset = actualStart + chunk.content.length;
				return {
					id: randomUUID(),
					sourceId: id,
					ordinal,
					content: chunk.content,
					startOffset: actualStart,
					endOffset: actualStart + chunk.content.length,
					tokenCount: estimateTokens(chunk.content),
					heading: chunk.heading,
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
				origin: canonSources.origin,
				language: canonSources.language,
				sourceKind: canonSources.sourceKind,
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
		return this.retrieve(companionId, query, { limit, includeAdjacent: false });
	}

	retrieve(
		companionId: string,
		query: string,
		options: { limit?: number; moduleId?: string; includeAdjacent?: boolean } = {},
	): CanonChunkRecord[] {
		const normalized = query.trim();
		if (!normalized) return [];
		const limit = Math.min(options.limit ?? 8, 30);
		const aliases = this.matchAliases(companionId, normalized);
		const queryTerms = normalized.split(/[\s，。！？；、,.!?;:：]+/).filter(Boolean);
		const terms = [
			...new Set([...queryTerms, ...aliases].filter((term) => term.length >= 3)),
		].slice(0, 8);
		if (terms.length === 0)
			return this.exactSearch(companionId, [...new Set([...queryTerms, ...aliases])], limit);
		const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
		const routedChunkIds = this.routedChunkIds(companionId, normalized, aliases, options.moduleId);
		const rows = this.db.all<{
			id: string;
			sourceId: string;
			sourceName: string;
			ordinal: number;
			content: string;
			heading: string | null;
			startOffset: number;
			endOffset: number;
			score: number;
			language: string | null;
			origin: "user" | "package";
		}>(sql`
			SELECT c.id, c.source_id AS sourceId, s.logical_name AS sourceName,
				c.ordinal, c.content, c.heading, c.start_offset AS startOffset,
				c.end_offset AS endOffset, bm25(canon_chunks_fts) AS score,
				s.language, s.origin
			FROM canon_chunks_fts
			JOIN canon_chunks c ON c.rowid = canon_chunks_fts.rowid
			JOIN canon_sources s ON s.id = c.source_id
			WHERE canon_chunks_fts MATCH ${ftsQuery} AND s.companion_id = ${companionId}
			ORDER BY bm25(canon_chunks_fts), c.source_id, c.ordinal
			LIMIT ${Math.max(limit * 3, 12)}
		`);
		const ranked = rows
			.filter((row) => routedChunkIds.size === 0 || routedChunkIds.has(row.id))
			.slice(0, limit)
			.map(toChunkRecord);
		if (options.includeAdjacent === false) return ranked;
		return this.expandAdjacent(ranked, limit);
	}

	syncPackage(companionId: string, canon: LoadedCanonPackage): void {
		const manifestHash = createHash("sha256")
			.update(JSON.stringify(canon.manifest))
			.update("\0")
			.update(canon.sources.map((source) => source.content).join("\0"))
			.digest("hex");
		const state = this.db
			.select({ hash: canonPackageState.manifestHash })
			.from(canonPackageState)
			.where(eq(canonPackageState.companionId, companionId))
			.get();
		if (state?.hash === manifestHash) return;
		this.db.transaction((transaction) => {
			transaction
				.delete(storyModules)
				.where(and(eq(storyModules.companionId, companionId), eq(storyModules.origin, "package")))
				.run();
			transaction
				.delete(canonEntities)
				.where(and(eq(canonEntities.companionId, companionId), eq(canonEntities.origin, "package")))
				.run();
			transaction
				.delete(canonSources)
				.where(and(eq(canonSources.companionId, companionId), eq(canonSources.origin, "package")))
				.run();
			const chunksBySource = new Map<
				string,
				Array<{ id: string; heading: string | null; start: number; end: number }>
			>();
			for (const source of canon.sources) {
				const sourceId = stableId(companionId, "source", source.id);
				const normalized = source.content.replaceAll("\r\n", "\n").trim();
				const artifact = this.artifacts.create({
					logicalName: source.title,
					buffer: Buffer.from(normalized),
					mime: "text/plain",
				});
				transaction
					.insert(canonSources)
					.values({
						id: sourceId,
						companionId,
						logicalName: source.title,
						mime: "text/plain",
						sha256: artifact.sha256,
						artifactId: artifact.id,
						origin: "package",
						stableKey: source.id,
						language: canon.manifest.language,
						sourceKind: source.kind,
					})
					.run();
				let cursor = 0;
				const indexed = splitCanon(normalized).map((chunk, ordinal) => {
					const start = normalized.indexOf(chunk.content, cursor);
					const actualStart = start < 0 ? cursor : start;
					cursor = actualStart + chunk.content.length;
					return {
						id: stableId(companionId, source.id, String(ordinal)),
						sourceId,
						ordinal,
						content: chunk.content,
						heading: chunk.heading,
						startOffset: actualStart,
						endOffset: cursor,
						tokenCount: estimateTokens(chunk.content),
					};
				});
				if (indexed.length) transaction.insert(canonChunks).values(indexed).run();
				chunksBySource.set(
					source.id,
					indexed.map((chunk) => ({
						id: chunk.id,
						heading: chunk.heading,
						start: chunk.startOffset,
						end: chunk.endOffset,
					})),
				);
			}
			if (canon.manifest.entities.length)
				transaction
					.insert(canonEntities)
					.values(
						canon.manifest.entities.map((entity) => ({
							id: stableId(companionId, "entity", entity.id),
							companionId,
							kind: entity.kind,
							name: entity.name,
							aliasesJson: entity.aliases,
							description: entity.description,
							origin: "package" as const,
							stableKey: entity.id,
						})),
					)
					.run();
			for (const module of canon.manifest.modules) {
				const refs = module.bindings.flatMap((binding) =>
					(chunksBySource.get(binding.source) ?? [])
						.filter((chunk) => {
							const headingMatch =
								!binding.headings?.length ||
								(chunk.heading !== null && binding.headings.includes(chunk.heading));
							const rangeMatch =
								(binding.start_offset === undefined || chunk.end > binding.start_offset) &&
								(binding.end_offset === undefined || chunk.start < binding.end_offset);
							return headingMatch && rangeMatch;
						})
						.map((chunk) => chunk.id),
				);
				transaction
					.insert(storyModules)
					.values({
						id: stableId(companionId, "module", module.id),
						companionId,
						parentId: module.parent ? stableId(companionId, "module", module.parent) : null,
						kind: module.kind,
						name: module.title,
						description: module.summary,
						sourceRefsJson: [...new Set(refs)],
						dependenciesJson: [],
						origin: "package",
						stableKey: module.id,
						triggersJson: module.triggers,
					})
					.run();
			}
			transaction
				.insert(canonPackageState)
				.values({ companionId, manifestHash })
				.onConflictDoUpdate({
					target: canonPackageState.companionId,
					set: { manifestHash, updatedAt: sql`datetime('now')` },
				})
				.run();
		});
		this.eventBus.publish("canon.package_synced", { companionId, version: canon.manifest.version });
	}

	removeSource(companionId: string, sourceId: string): void {
		const source = this.db
			.select({ origin: canonSources.origin })
			.from(canonSources)
			.where(and(eq(canonSources.id, sourceId), eq(canonSources.companionId, companionId)))
			.get();
		if (source?.origin === "package")
			throw { kind: "invalid_request", reason: "package_canon_is_read_only" };
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
				origin: row.origin,
				...(row.stableKey ? { stableKey: row.stableKey } : {}),
				triggers: row.triggersJson,
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
		const existingOwned = this.db
			.select({ origin: storyModules.origin })
			.from(storyModules)
			.where(eq(storyModules.id, id))
			.get();
		if (existingOwned?.origin === "package")
			throw { kind: "invalid_request", reason: "package_canon_is_read_only" };
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
				origin: "user",
				triggersJson: [],
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
		const module = this.db
			.select({ origin: storyModules.origin })
			.from(storyModules)
			.where(and(eq(storyModules.id, id), eq(storyModules.companionId, companionId)))
			.get();
		if (module?.origin === "package")
			throw { kind: "invalid_request", reason: "package_canon_is_read_only" };
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
					origin: canonSources.origin,
					language: canonSources.language,
					sourceKind: canonSources.sourceKind,
					chunkCount: count(canonChunks.id),
				})
				.from(canonSources)
				.leftJoin(canonChunks, eq(canonChunks.sourceId, canonSources.id))
				.where(eq(canonSources.id, id))
				.groupBy(canonSources.id)
				.get() ?? null
		);
	}

	private matchAliases(companionId: string, query: string): string[] {
		return this.db
			.select({ name: canonEntities.name, aliases: canonEntities.aliasesJson })
			.from(canonEntities)
			.where(eq(canonEntities.companionId, companionId))
			.all()
			.filter((entity) => [entity.name, ...entity.aliases].some((alias) => query.includes(alias)))
			.flatMap((entity) => [entity.name, ...entity.aliases]);
	}

	private exactSearch(companionId: string, terms: string[], limit: number): CanonChunkRecord[] {
		if (!terms.length) return [];
		const rows = this.db
			.select({
				id: canonChunks.id,
				sourceId: canonChunks.sourceId,
				sourceName: canonSources.logicalName,
				ordinal: canonChunks.ordinal,
				content: canonChunks.content,
				heading: canonChunks.heading,
				startOffset: canonChunks.startOffset,
				endOffset: canonChunks.endOffset,
				language: canonSources.language,
				origin: canonSources.origin,
			})
			.from(canonChunks)
			.innerJoin(canonSources, eq(canonSources.id, canonChunks.sourceId))
			.where(eq(canonSources.companionId, companionId))
			.orderBy(asc(canonChunks.sourceId), asc(canonChunks.ordinal))
			.all();
		return rows
			.filter((row) => terms.some((term) => row.content.includes(term)))
			.slice(0, limit)
			.map(toChunkRecord);
	}

	private routedChunkIds(
		companionId: string,
		query: string,
		aliases: string[],
		moduleId?: string,
	): Set<string> {
		const modules = this.db
			.select()
			.from(storyModules)
			.where(eq(storyModules.companionId, companionId))
			.all();
		const requested = moduleId
			? modules.filter((module) => module.stableKey === moduleId || module.id === moduleId)
			: modules.filter(
					(module) =>
						module.triggersJson.some((trigger) => query.includes(trigger)) ||
						aliases.some((alias) => `${module.name} ${module.description}`.includes(alias)),
				);
		if (!requested.length) return new Set();
		const selected = new Set(requested.map((module) => module.id));
		let changed = true;
		while (changed) {
			changed = false;
			for (const module of modules)
				if (module.parentId && selected.has(module.parentId) && !selected.has(module.id)) {
					selected.add(module.id);
					changed = true;
				}
		}
		return new Set(
			modules
				.filter((module) => selected.has(module.id))
				.flatMap((module) => module.sourceRefsJson),
		);
	}

	private expandAdjacent(ranked: CanonChunkRecord[], limit: number): CanonChunkRecord[] {
		const result = [...ranked];
		const seen = new Set(result.map((row) => row.id));
		for (const hit of ranked) {
			if (result.length >= limit) break;
			const rows = this.db
				.select({
					id: canonChunks.id,
					sourceId: canonChunks.sourceId,
					sourceName: canonSources.logicalName,
					ordinal: canonChunks.ordinal,
					content: canonChunks.content,
					heading: canonChunks.heading,
					startOffset: canonChunks.startOffset,
					endOffset: canonChunks.endOffset,
					language: canonSources.language,
					origin: canonSources.origin,
				})
				.from(canonChunks)
				.innerJoin(canonSources, eq(canonSources.id, canonChunks.sourceId))
				.where(
					and(
						eq(canonChunks.sourceId, hit.sourceId),
						inArray(canonChunks.ordinal, [hit.ordinal - 1, hit.ordinal + 1]),
					),
				)
				.orderBy(asc(canonChunks.ordinal))
				.all();
			for (const row of rows)
				if (!seen.has(row.id) && result.length < limit) {
					seen.add(row.id);
					result.push({ ...toChunkRecord(row), adjacent: true });
				}
		}
		return result;
	}
}

function splitCanon(content: string): Array<{ content: string; heading: string | null }> {
	const paragraphs = content
		.split(/\n{2,}/)
		.map((part) => part.trim())
		.filter(Boolean);
	const chunks: Array<{ content: string; heading: string | null }> = [];
	let current = "";
	let heading: string | null = null;
	for (const paragraph of paragraphs) {
		const headingMatch = paragraph.match(/^(?:#{1,6}\s+(.+)|((?:第.{1,20}[章幕篇部卷]).*))$/);
		if (headingMatch) heading = (headingMatch[1] ?? headingMatch[2] ?? paragraph).trim();
		if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
			chunks.push({ content: current, heading });
			current = "";
		}
		if (paragraph.length <= MAX_CHUNK_CHARS)
			current = current ? `${current}\n\n${paragraph}` : paragraph;
		else
			for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARS)
				chunks.push({ content: paragraph.slice(offset, offset + MAX_CHUNK_CHARS), heading });
	}
	if (current) chunks.push({ content: current, heading });
	return chunks;
}

function stableId(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function toChunkRecord(row: {
	id: string;
	sourceId: string;
	sourceName: string;
	ordinal: number;
	content: string;
	heading: string | null;
	startOffset: number;
	endOffset: number;
	score?: number;
	language: string | null;
	origin: "user" | "package";
}): CanonChunkRecord {
	return {
		id: row.id,
		sourceId: row.sourceId,
		sourceName: row.sourceName,
		ordinal: row.ordinal,
		content: row.content,
		...(row.heading ? { heading: row.heading } : {}),
		startOffset: row.startOffset,
		endOffset: row.endOffset,
		...(row.score !== undefined ? { score: row.score } : {}),
		...(row.language ? { language: row.language } : {}),
		origin: row.origin,
	};
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}
