import { createHash, randomUUID } from "node:crypto";
import { CacheKey } from "@bear-harness/protocol/schema";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { ArtifactStore } from "../artifacts/index.js";
import type { AppDatabase, CanonVectorIndex } from "../storage/database.js";
import type { InvalidationHub } from "../storage/invalidation-hub.js";
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

const MAX_CHUNK_CHARS = 1600;

export interface CanonEmbeddingService {
	isReady(): boolean;
	getDimensions(): number;
	getProviderInfo(): { provider: string; model: string };
	embed(text: string, purpose?: "query" | "document"): Promise<Float32Array>;
}

interface CanonEmbeddingConfiguration {
	dimensions: number;
	fingerprint: string;
}

export class CanonHubService {
	private readonly indexing = new Map<string, Promise<void>>();
	private closed = false;
	constructor(
		private readonly db: AppDatabase,
		private readonly artifacts: ArtifactStore,
		private readonly invalidations: InvalidationHub,
		private readonly embeddingService?: () =>
			| CanonEmbeddingService
			| undefined
			| Promise<CanonEmbeddingService | undefined>,
		private readonly vectors?: CanonVectorIndex,
		private readonly onIndexError?: (error: unknown) => void,
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
		this.invalidations.invalidate(CacheKey.canonSources(companionId));
		const source = this.getSource(id);
		if (!source) throw { kind: "internal", reason: "canon_source_not_persisted" };
		void this.indexPending(companionId).catch((error: unknown) => this.onIndexError?.(error));
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
			.orderBy(desc(canonSources.createdAt), asc(canonSources.id))
			.all();
	}

	search(companionId: string, query: string, limit = 12): CanonChunkRecord[] {
		return this.retrieve(companionId, query, { limit, includeAdjacent: false });
	}

	retrieve(
		companionId: string,
		query: string,
		options: {
			limit?: number;
			includeAdjacent?: boolean;
		} = {},
	): CanonChunkRecord[] {
		const normalized = query.trim();
		if (!normalized) return [];
		const limit = Math.min(options.limit ?? 8, 30);
		const queryTerms = [
			...new Set(normalized.split(/[\s，。！？；、,.!?;:：]+/).filter(Boolean)),
		].slice(0, 8);
		// The trigram index cannot match short CJK names or words. Keep them when
		// mixed with longer terms, and rank the same canonical rows by term coverage.
		if (queryTerms.some((term) => term.length < 3 && /\p{Script=Han}/u.test(term))) {
			const ranked = this.exactSearch(companionId, queryTerms, limit);
			return options.includeAdjacent === false ? ranked : this.expandAdjacent(ranked, limit);
		}
		const terms = [...new Set(queryTerms.filter((term) => term.length >= 3))].slice(0, 8);
		if (!terms.length) return this.exactSearch(companionId, queryTerms, limit);
		const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
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
		const ranked = rows.slice(0, limit).map(toChunkRecord);
		if (options.includeAdjacent === false) return ranked;
		return this.expandAdjacent(ranked, limit);
	}

	/**
	 * Retrieves canonical evidence with reciprocal-rank fusion of FTS and cosine
	 * similarity. With embeddings disabled, uses lexical retrieval. A configured provider
	 * must complete indexing; failures are surfaced instead of disguised as misses.
	 */
	async retrieveHybrid(
		companionId: string,
		query: string,
		options: {
			limit?: number;
			includeAdjacent?: boolean;
		} = {},
	): Promise<CanonChunkRecord[]> {
		if (!query.trim()) return [];
		await this.indexPending(companionId);
		this.assertOpen();
		const limit = Math.min(options.limit ?? 8, 30);
		const lexical = this.retrieve(companionId, query, {
			...options,
			limit: Math.max(limit * 3, 12),
			includeAdjacent: false,
		});
		const service = await this.embeddingService?.();
		this.assertOpen();
		if (!service) {
			const finalized = this.finalizeHybrid(lexical, limit, options.includeAdjacent);
			return finalized;
		}
		const configuration = canonEmbeddingConfiguration(service);
		const vectors = this.vectors;
		if (!configuration || !vectors || !this.ensureVectorIndex(configuration))
			throw new Error("Canon vector index is unavailable");
		const queryEmbedding = await service.embed(query.trim(), "query");
		this.assertOpen();
		const currentConfiguration = canonEmbeddingConfiguration(await this.embeddingService?.());
		this.assertOpen();
		if (
			queryEmbedding.length !== configuration.dimensions ||
			currentConfiguration?.fingerprint !== configuration.fingerprint ||
			!this.ensureVectorIndex(configuration)
		)
			throw new Error("Canon embedding configuration changed during retrieval");
		const vectorRows = vectors.searchCanonVectors(queryEmbedding, Math.max(limit * 6, 48));
		const candidates = this.db
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
					eq(canonSources.companionId, companionId),
					inArray(
						canonChunks.id,
						vectorRows.map((row) => row.chunkId),
					),
				),
			)
			.all();
		const candidateById = new Map(candidates.map((row) => [row.id, toChunkRecord(row)]));
		const vector = vectorRows
			.map(({ chunkId, distance }) => ({
				row: candidateById.get(chunkId),
				score: 1 - distance,
			}))
			.filter(
				(candidate): candidate is { row: CanonChunkRecord; score: number } =>
					candidate.row !== undefined && Number.isFinite(candidate.score) && candidate.score > 0,
			);
		const fused = new Map<string, { row: CanonChunkRecord; score: number }>();
		for (const [rank, row] of lexical.entries())
			fused.set(row.id, { row, score: 1 / (60 + rank + 1) });
		for (const [rank, hit] of vector.entries()) {
			const current = fused.get(hit.row.id);
			const score = (current?.score ?? 0) + 1 / (60 + rank + 1);
			fused.set(hit.row.id, { row: { ...hit.row, score: hit.score }, score });
		}
		const finalized = this.finalizeHybrid(
			[...fused.values()].sort((left, right) => right.score - left.score).map((hit) => hit.row),
			limit,
			options.includeAdjacent,
		);
		return finalized;
	}

	async searchHybrid(companionId: string, query: string, limit = 12): Promise<CanonChunkRecord[]> {
		return this.retrieveHybrid(companionId, query, { limit, includeAdjacent: false });
	}

	syncPackage(companionId: string, canon: LoadedCanonPackage): void {
		const manifestHash = createHash("sha256")
			.update("canon-body-chunks-v2\0")
			.update(JSON.stringify(canon.sources))
			.update("\0")
			.update(canon.sources.map((source) => source.content).join("\0"))
			.digest("hex");
		const state = this.db
			.select({ hash: canonPackageState.manifestHash })
			.from(canonPackageState)
			.where(eq(canonPackageState.companionId, companionId))
			.get();
		if (state?.hash === manifestHash) {
			void this.indexPending(companionId).catch((error: unknown) => this.onIndexError?.(error));
			return;
		}
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
						language: null,
						sourceKind: "reference",
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
		this.invalidations.invalidate(CacheKey.canonSources(companionId));
		void this.indexPending(companionId).catch((error: unknown) => this.onIndexError?.(error));
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
		this.invalidations.invalidate(CacheKey.canonSources(companionId));
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

	/** Embed unindexed chunks after a source/package transaction commits. */
	indexPending(companionId: string): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Canon service is closed"));
		const previous = this.indexing.get(companionId) ?? Promise.resolve();
		// Serialize source changes and queries so a search includes writes admitted
		// while an earlier indexing pass was awaiting the provider.
		const pending = previous.catch(() => undefined).then(() => this.indexChunks(companionId));
		this.indexing.set(companionId, pending);
		void pending
			.finally(() => {
				if (this.indexing.get(companionId) === pending) this.indexing.delete(companionId);
			})
			.catch(() => undefined);
		return pending;
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled(this.indexing.values());
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Canon service is closed");
	}

	private async indexChunks(companionId: string): Promise<void> {
		this.assertOpen();
		const service = await this.embeddingService?.();
		this.assertOpen();
		if (!service) return;
		const configuration = canonEmbeddingConfiguration(service);
		const vectors = this.vectors;
		if (!configuration || !vectors || !this.ensureVectorIndex(configuration))
			throw new Error("Canon vector index is unavailable");
		const rows = this.db
			.select({
				id: canonChunks.id,
				content: canonChunks.content,
				embedding: canonChunks.embedding,
			})
			.from(canonChunks)
			.innerJoin(canonSources, eq(canonSources.id, canonChunks.sourceId))
			.where(eq(canonSources.companionId, companionId))
			.all();
		for (const row of rows) {
			const embedding = row.embedding
				? decodeEmbedding(row.embedding)
				: await service.embed(row.content, "document");
			this.assertOpen();
			const currentConfiguration = canonEmbeddingConfiguration(await this.embeddingService?.());
			this.assertOpen();
			if (
				embedding.length !== configuration.dimensions ||
				currentConfiguration?.fingerprint !== configuration.fingerprint
			)
				throw new Error("Canon embedding configuration changed during indexing");
			// A source can be replaced or deleted while embedding is in flight.
			const current = this.db
				.select({ content: canonChunks.content })
				.from(canonChunks)
				.where(eq(canonChunks.id, row.id))
				.get();
			if (current?.content !== row.content) continue;
			this.db.transaction(() => {
				vectors.upsertCanonVector(row.id, embedding);
				if (!row.embedding)
					this.db
						.update(canonChunks)
						.set({ embedding: encodeEmbedding(embedding) })
						.where(eq(canonChunks.id, row.id))
						.run();
			});
		}
	}

	private ensureVectorIndex(configuration: CanonEmbeddingConfiguration): boolean {
		return this.vectors?.ensureCanonVectorIndex(configuration).ready ?? false;
	}

	private finalizeHybrid(
		ranked: CanonChunkRecord[],
		limit: number,
		includeAdjacent: boolean | undefined,
	): CanonChunkRecord[] {
		const selected = ranked.slice(0, limit);
		return includeAdjacent === false ? selected : this.expandAdjacent(selected, limit);
	}

	private exactSearch(companionId: string, terms: string[], limit: number): CanonChunkRecord[] {
		if (!terms.length) return [];
		const matches = sql.join(
			terms.map(
				(term) => sql`CASE WHEN instr(lower(c.content), lower(${term})) > 0 THEN 1 ELSE 0 END`,
			),
			sql` + `,
		);
		const rows = this.db.all<Parameters<typeof toChunkRecord>[0]>(sql`
			SELECT c.id, c.source_id AS sourceId, s.logical_name AS sourceName,
				c.ordinal, c.content, c.heading, c.start_offset AS startOffset,
				c.end_offset AS endOffset, -(${matches}) AS score, s.language, s.origin
			FROM canon_chunks c JOIN canon_sources s ON s.id = c.source_id
			WHERE s.companion_id = ${companionId} AND (${matches}) > 0
			ORDER BY score, c.source_id, c.ordinal LIMIT ${limit}
		`);
		return rows.map(toChunkRecord);
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
	const flush = () => {
		if (!current) return;
		if (/^#{1,6}\s+[^\n]+$/.test(current)) {
			current = "";
			return;
		}
		chunks.push({ content: current, heading });
		current = "";
	};
	for (const paragraph of paragraphs) {
		const markdownHeading = paragraph.match(/^(#{1,6})\s+(.+)$/);
		const proseHeading = paragraph.match(/^((?:第.{1,20}[章幕篇部卷]).*)$/);
		const startsBoundSection =
			(markdownHeading !== null && (markdownHeading[1]?.length ?? 0) <= 2) || proseHeading !== null;
		if (startsBoundSection) {
			// Keep independent sections apart and label the previous text before
			// switching headings. A heading alone is not retrieval evidence.
			flush();
			heading = (markdownHeading?.[2] ?? proseHeading?.[1] ?? paragraph).trim();
		}
		if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
			flush();
		}
		if (paragraph.length <= MAX_CHUNK_CHARS)
			current = current ? `${current}\n\n${paragraph}` : paragraph;
		else {
			flush();
			for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARS)
				chunks.push({ content: paragraph.slice(offset, offset + MAX_CHUNK_CHARS), heading });
		}
	}
	flush();
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

function encodeEmbedding(vector: Float32Array): Buffer {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function canonEmbeddingConfiguration(
	service: CanonEmbeddingService | undefined,
): CanonEmbeddingConfiguration | undefined {
	try {
		if (!service?.isReady()) return undefined;
		const dimensions = service.getDimensions();
		if (!Number.isSafeInteger(dimensions) || dimensions <= 0) return undefined;
		const info = service.getProviderInfo();
		const identity = JSON.stringify({
			provider: info.provider.trim(),
			model: info.model.trim(),
			dimensions,
		});
		return {
			dimensions,
			fingerprint: createHash("sha256").update(identity, "utf8").digest("hex"),
		};
	} catch {
		return undefined;
	}
}

function decodeEmbedding(blob: Uint8Array): Float32Array {
	if (blob.byteLength === 0 || blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0)
		return new Float32Array();
	return new Float32Array(
		blob.buffer,
		blob.byteOffset,
		blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
	);
}
