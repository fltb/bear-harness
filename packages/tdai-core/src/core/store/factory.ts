/**
 * Store Factory — creates the appropriate storage backend and embedding service
 * based on plugin configuration.
 *
 * Supports:
 * - "sqlite" (default): local SQLite + sqlite-vec + FTS5
 * - "tcvdb": Tencent Cloud VectorDB (server-side embedding + hybridSearch)
 */

import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore, IEmbeddingService, StoreLogger } from "./types.js";
import { VectorStore } from "./sqlite.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import type { EmbeddingService } from "./embedding.js";

// Re-export for convenience
export type { IMemoryStore, IEmbeddingService, StoreLogger };

const TAG = "[memory-tdai][factory]";

export interface StoreBundle {
	store: IMemoryStore;
	embedding: IEmbeddingService;
	/** Snapshot of current store config for manifest writing. */
	storeSnapshot: import("../../utils/manifest.js").StoreConfigSnapshot;
}

/**
 * Create the storage backend, embedding service, and optional BM25 encoder
 * based on plugin configuration.
 *
 * @param config       Fully resolved plugin config.
 * @param options.dataDir    Plugin data directory.
 * @param options.logger     Logger instance.
 */
export function createStoreBundle(
	config: MemoryTdaiConfig,
	options: { dataDir: string; logger?: StoreLogger },
): StoreBundle {
	const { logger } = options;

	switch (config.storeBackend) {
		case "tcvdb":
			throw new Error(`${TAG} TCVDB backend is not part of this product release`);

		case "sqlite":
		default: {
			// ── Embedding service (only when enabled) ──
			// provider="none" with no endpoint/key stays disabled (hybrid recall
			// degrades to FTS+BM25); provider="local" enables the offline
			// node-llama-cpp embedder; any other provider with an endpoint or key
			// builds a remote OpenAI-compatible service (a keyless self-hosted
			// endpoint such as Ollama counts as a remote too).
			let embeddingService: EmbeddingService | undefined;
			if (config.embedding.enabled) {
				if (config.embedding.provider === "local") {
					embeddingService = createEmbeddingService(
						{
							provider: "local",
							...(config.embedding.modelPath ? { modelPath: config.embedding.modelPath } : {}),
							...(config.embedding.modelCacheDir
								? { modelCacheDir: config.embedding.modelCacheDir }
								: {}),
							dimensions: config.embedding.dimensions,
							...(config.embedding.hfEndpoint ? { hfEndpoint: config.embedding.hfEndpoint } : {}),
							...(config.embedding.download !== undefined
								? { download: config.embedding.download }
								: {}),
						},
						logger,
					);
				} else if (config.embedding.baseUrl || config.embedding.apiKey) {
					embeddingService = createEmbeddingService(
						{
							provider: config.embedding.provider,
							baseUrl: config.embedding.baseUrl,
							apiKey: config.embedding.apiKey,
							model: config.embedding.model,
							dimensions: config.embedding.dimensions,
							sendDimensions: config.embedding.sendDimensions,
							maxInputChars: config.embedding.maxInputChars,
						},
						logger,
					);
				}
			}

			// dimensions from config (0 when provider="none" → vec0 deferred)
			const dims = config.embedding.dimensions;
			const dbPath = path.join(options.dataDir, "vectors.db");
			const store = new VectorStore(dbPath, dims, logger);

			logger?.debug?.(
				`${TAG} Store created: backend=sqlite, dbPath=${dbPath}, dimensions=${dims}, ` +
					`embedding=${embeddingService ? "enabled" : "disabled"}`,
			);

			return {
				store,
				embedding: embeddingService as unknown as IEmbeddingService,
				storeSnapshot: {
					type: "sqlite",
					sqlitePath: path.relative(options.dataDir, dbPath),
				},
			};
		}
	}
}
