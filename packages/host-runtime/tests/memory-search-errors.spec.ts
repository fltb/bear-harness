import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../tdai-core/src/config.js";
import { performAutoRecall } from "../../tdai-core/src/core/hooks/auto-recall.js";
import type { EmbeddingService } from "../../tdai-core/src/core/store/embedding.js";
import { VectorStore } from "../../tdai-core/src/core/store/sqlite.js";
import { executeConversationSearch } from "../../tdai-core/src/core/tools/conversation-search.js";
import { executeMemorySearch } from "../../tdai-core/src/core/tools/memory-search.js";

function openStore() {
	const store = new VectorStore(":memory:", 3);
	const initialized = store.init();
	if (store.isDegraded()) {
		store.close();
		throw new Error(initialized.reason ?? "Test SQLite store failed to initialize");
	}
	return store;
}

function embedding(values = [1, 0, 0]) {
	return { embed: async () => new Float32Array(values) } as EmbeddingService;
}

function diagnostics() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

for (const layer of ["memory", "conversation"] as const) {
	const search = layer === "memory" ? executeMemorySearch : executeConversationSearch;
	describe(`${layer} search failure semantics`, () => {
		it("distinguishes a successful zero-hit hybrid query from unavailable retrieval", async () => {
			const store = openStore();
			try {
				await expect(
					search({ query: "absent", limit: 5, vectorStore: store, embeddingService: embedding() }),
				).resolves.toMatchObject({ results: [], total: 0, strategy: "hybrid" });
				store.close();
				await expect(
					search({ query: "absent", limit: 5, vectorStore: store }),
				).rejects.toMatchObject({ code: "memory_search_unavailable" });
			} finally {
				store.close();
			}
		});

		it("rejects missing stores but permits an intentionally empty query", async () => {
			await expect(search({ query: "remember", limit: 5 })).rejects.toMatchObject({
				code: "memory_search_unavailable",
			});
			await expect(search({ query: "   ", limit: 5 })).resolves.toMatchObject({
				results: [],
				total: 0,
				strategy: "none",
			});
		});

		it("keeps a successful zero-hit keyword fallback when vector retrieval fails", async () => {
			const store = openStore();
			const logger = diagnostics();
			try {
				await expect(
					search({
						query: "absent",
						limit: 5,
						vectorStore: store,
						embeddingService: embedding([1, 0]),
						logger,
					}),
				).resolves.toMatchObject({ results: [], total: 0, strategy: "fts" });
				expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("memory_search_degraded"));
				if (layer === "memory") {
					store.upsertL1(
						{
							id: "kept-memory",
							content: "remember midnight",
							type: "persona",
							priority: 50,
							scene_name: "",
							source_message_ids: [],
							metadata: {},
							timestamps: [],
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							sessionKey: "conversation-a",
							sessionId: "session-a",
						},
						new Float32Array([1, 0, 0]),
					);
				} else {
					store.upsertL0(
						{
							id: "kept-memory",
							messageText: "remember midnight",
							role: "user",
							recordedAt: "2026-01-01T00:00:00.000Z",
							timestamp: 1,
							sessionKey: "conversation-a",
							sessionId: "session-a",
						},
						new Float32Array([1, 0, 0]),
					);
				}
				await expect(
					search({
						query: "midnight",
						limit: 5,
						vectorStore: store,
						embeddingService: embedding([1, 0]),
						logger,
					}),
				).resolves.toMatchObject({
					results: [expect.objectContaining({ id: "kept-memory", content: "remember midnight" })],
					total: 1,
					strategy: "fts",
				});
			} finally {
				store.close();
			}
		});

		it("uses vector fallback after a keyword SQL error, and rejects when both branches fail", async () => {
			const store = openStore();
			const logger = diagnostics();
			const keywordMethod = layer === "memory" ? "searchL1Fts" : "searchL0Fts";
			const keywordSearch = store[keywordMethod].bind(store);
			// Execute malformed FTS syntax against the real database rather than fabricate a query result.
			vi.spyOn(store, keywordMethod).mockImplementation(() => keywordSearch('"') as never);
			try {
				await expect(
					search({
						query: "absent",
						limit: 5,
						vectorStore: store,
						embeddingService: embedding(),
						logger,
					}),
				).resolves.toMatchObject({ results: [], total: 0, strategy: "embedding" });
				expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("memory_search_degraded"));
				await expect(
					search({
						query: "absent",
						limit: 5,
						vectorStore: store,
						embeddingService: embedding([1, 0]),
						logger,
					}),
				).rejects.toMatchObject({
					code: "memory_search_failed",
					errors: [expect.any(Error), expect.any(Error)],
				});
			} finally {
				vi.restoreAllMocks();
				store.close();
			}
		});
	});
}

describe("SQLite retrieval and rebuild failures", () => {
	it("does not turn a degraded store or SQL errors into empty results", () => {
		const store = openStore();
		try {
			expect(() => store.searchL1Fts('"')).toThrow(
				expect.objectContaining({ code: "memory_search_failed" }),
			);
			expect(() => store.searchL0Fts('"')).toThrow(
				expect.objectContaining({ code: "memory_search_failed" }),
			);
			Reflect.set(store, "degraded", true);
			for (const query of [
				() => store.searchL1Fts("absent"),
				() => store.searchL0Fts("absent"),
				() => store.searchL1Vector(new Float32Array([1, 0, 0])),
				() => store.searchL0Vector(new Float32Array([1, 0, 0])),
			]) {
				expect(query).toThrow(expect.objectContaining({ code: "memory_search_unavailable" }));
			}
		} finally {
			store.close();
		}
	});

	for (const table of ["l1_records", "l0_conversations"]) {
		it(`does not report a complete rebuild after ${table} enumeration fails or remove existing records`, async () => {
			const store = openStore();
			const db = Reflect.get(store, "db") as DatabaseSync;
			const prepare = db.prepare.bind(db);
			store.upsertL0(
				{
					id: "kept-message",
					sessionKey: "conversation-a",
					sessionId: "session-a",
					role: "user",
					messageText: "preserved memory",
					recordedAt: "2026-01-01T00:00:00.000Z",
					timestamp: 1,
				},
				new Float32Array([1, 0, 0]),
			);
			const failure = vi.spyOn(db, "prepare").mockImplementation((sql) => {
				if (sql.includes(`FROM ${table}`)) throw new Error("injected read failure");
				return prepare(sql);
			});
			try {
				const enumerate = () =>
					table === "l1_records" ? store.getAllL1Texts() : store.getAllL0Texts();
				expect(enumerate).toThrow(
					expect.objectContaining({
						cause: expect.objectContaining({ message: "injected read failure" }),
					}),
				);
				await expect(
					store.reindexAll(async () => new Float32Array([1, 0, 0])),
				).resolves.toMatchObject({
					complete: false,
					error: expect.stringContaining("enumeration failed"),
				});
				failure.mockRestore();
				expect(store.getAllL0Texts()).toEqual([
					expect.objectContaining({ record_id: "kept-message", message_text: "preserved memory" }),
				]);
				expect(store.searchL0Fts("preserved")).toEqual([
					expect.objectContaining({ record_id: "kept-message" }),
				]);
			} finally {
				failure.mockRestore();
				store.close();
			}
		});
	}
});

describe("optional automatic recall diagnostics", () => {
	it("retains readable persona context while marking memory retrieval as failed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bear-recall-errors-"));
		const logger = diagnostics();
		try {
			await writeFile(join(directory, "persona.md"), "A verified persona note", "utf8");
			const result = await performAutoRecall({
				userText: "remember preferences",
				actorId: "user",
				sessionKey: "session",
				pluginDataDir: directory,
				cfg: parseConfig({ recall: { strategy: "keyword" } }),
				logger,
			});
			expect(result).toMatchObject({
				recallStrategy: "failed",
				recalledL3Persona: "A verified persona note",
			});
			expect(result?.prependContext).toBeUndefined();
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("memory_recall_failed"));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("logs a timeout and releases the caller before a slow embedding settles", async () => {
		const store = openStore();
		const directory = await mkdtemp(join(tmpdir(), "bear-recall-timeout-"));
		const logger = diagnostics();
		const gate = Promise.withResolvers<Float32Array>();
		const searched = Promise.withResolvers<void>();
		const searchVector = store.searchL1Vector.bind(store);
		vi.spyOn(store, "searchL1Vector").mockImplementation((...args) => {
			try {
				return searchVector(...args);
			} finally {
				searched.resolve();
			}
		});
		vi.useFakeTimers();
		try {
			const recall = performAutoRecall({
				userText: "remember preferences",
				actorId: "user",
				sessionKey: "session",
				pluginDataDir: directory,
				cfg: parseConfig({ recall: { strategy: "embedding", timeoutMs: 10 } }),
				vectorStore: store,
				embeddingService: { embed: () => gate.promise } as EmbeddingService,
				logger,
			});
			await vi.advanceTimersByTimeAsync(11);
			await expect(recall).resolves.toBeUndefined();
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("memory_recall_timeout"));
		} finally {
			gate.resolve(new Float32Array([1, 0, 0]));
			await searched.promise;
			vi.useRealTimers();
			vi.restoreAllMocks();
			store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
