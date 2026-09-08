import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingService } from "../../tdai-core/src/core/store/embedding.js";
import { TcvdbMemoryStore } from "../../tdai-core/src/core/store/tcvdb.js";
import { executeConversationSearch } from "../../tdai-core/src/core/tools/conversation-search.js";
import { executeMemorySearch } from "../../tdai-core/src/core/tools/memory-search.js";

async function fixture() {
	const state = {
		fail: false,
		failInit: false,
		partialPage: false,
		reset: false,
		resetRequests: 0,
	};
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			const path = request.url;
			if (state.reset) {
				state.resetRequests++;
				request.socket.destroy();
				return;
			}
			const input = JSON.parse(body) as { query?: { offset?: number } };
			const denied =
				state.failInit ||
				(state.fail && path?.startsWith("/document/")) ||
				(state.partialPage && path === "/document/query" && input.query?.offset === 100);
			let payload: Record<string, unknown>;
			if (denied) {
				payload = { code: 16001, msg: "isolated_remote_access_denied" };
			} else if (path === "/database/list") {
				payload = { code: 0, databases: ["memory_fixture"] };
			} else if (path === "/collection/describe") {
				payload = { code: 0, collection: {} };
			} else if (path === "/document/count") {
				payload = { code: 0, count: 0 };
			} else if (path === "/document/query") {
				payload = {
					code: 0,
					documents: state.partialPage
						? Array.from({ length: 100 }, (_, id) => ({
								schema_version: 1,
								id: String(id),
								text: "kept",
							}))
						: [],
				};
			} else if (path === "/document/search" || path === "/document/hybridSearch") {
				payload = { code: 0, documents: [[]] };
			} else {
				response.writeHead(400, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ code: -1, msg: `Unexpected fixture request: ${path}` }));
				return;
			}
			response.writeHead(denied ? 403 : 200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(payload));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server address");
	const url = `http://127.0.0.1:${address.port}`;
	const store = new TcvdbMemoryStore({
		url,
		username: "fixture",
		apiKey: "fixture",
		database: "memory_fixture",
		embeddingModel: "bge-m3",
		timeout: 1_000,
		logger,
	});
	return {
		store,
		state,
		logger,
		url,
		close: async () => {
			store.close();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
		},
	};
}

for (const layer of ["memory", "conversation"] as const) {
	const search = layer === "memory" ? executeMemorySearch : executeConversationSearch;
	it(`${layer} retrieval distinguishes a valid remote zero-hit result from transport rejection`, async () => {
		const { store, state, logger, close } = await fixture();
		try {
			await store.init();
			const params = {
				query: "absent",
				limit: 5,
				vectorStore: store,
				logger,
				embeddingService: { embed: async () => new Float32Array([1, 0, 0]) } as EmbeddingService,
			};
			await expect(search(params)).resolves.toMatchObject({
				results: [],
				total: 0,
				strategy: "embedding",
			});
			const vectorSearch =
				layer === "memory" ? store.searchL1Vector.bind(store) : store.searchL0Vector.bind(store);
			await expect(vectorSearch(new Float32Array([1]))).rejects.toMatchObject({
				code: "memory_search_unavailable",
			});
			state.fail = true;
			await expect(search(params)).rejects.toMatchObject({
				code: "memory_search_failed",
				errors: [
					expect.objectContaining({
						code: "memory_search_failed",
						cause: expect.objectContaining({ apiCode: 16001 }),
					}),
				],
			});
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("isolated_remote_access_denied"),
			);
		} finally {
			await close();
		}
	});
}

describe("remote enumeration and readiness failures", () => {
	it("does not turn failed counts or record enumeration into empty collections", async () => {
		const { store, state, close } = await fixture();
		try {
			await store.init();
			const reads = [
				() => store.queryL1Records(),
				() => store.getAllL1Texts(),
				() => store.queryL0ForL1("session"),
				() => store.queryL0GroupedBySessionId("session"),
				() => store.getAllL0Texts(),
			];
			for (const read of reads) await expect(read()).resolves.toEqual([]);
			await expect(store.countL1()).resolves.toBe(0);
			await expect(store.countL0()).resolves.toBe(0);
			state.fail = true;
			for (const read of [...reads, () => store.countL1(), () => store.countL0()]) {
				await expect(read()).rejects.toMatchObject({
					code: "memory_search_failed",
					cause: expect.any(Error),
				});
			}
		} finally {
			await close();
		}
	});

	it("rejects incomplete pagination rather than reporting an empty or partial inventory", async () => {
		const { store, state, close } = await fixture();
		try {
			await store.init();
			state.partialPage = true;
			await expect(store.getAllL1Texts()).rejects.toMatchObject({
				code: "memory_search_failed",
				cause: expect.objectContaining({ apiCode: 16001 }),
			});
			await expect(store.getAllL0Texts()).rejects.toMatchObject({
				code: "memory_search_failed",
				cause: expect.objectContaining({ apiCode: 16001 }),
			});
		} finally {
			await close();
		}
	});

	it("rejects uninitialized and failed configured reads while retaining the initialization cause", async () => {
		const { store, state, logger, close } = await fixture();
		try {
			await expect(store.getAllL1Texts()).rejects.toMatchObject({
				code: "memory_search_unavailable",
			});
			state.failInit = true;
			await store.init();
			expect(store.isDegraded()).toBe(true);
			await expect(store.searchL0Vector(new Float32Array([1]), 5, "absent")).rejects.toMatchObject({
				code: "memory_search_unavailable",
				cause: expect.objectContaining({ apiCode: 16001 }),
			});
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("isolated_remote_access_denied"),
			);
		} finally {
			await close();
		}
	});

	it("preserves the original network error after transport retries are exhausted", async () => {
		const { store, state, logger, url, close } = await fixture();
		const transportErrors: Error[] = [];
		const requestErrors = channel("undici:request:error");
		const recordError = (message: unknown) => {
			if (
				typeof message === "object" &&
				message !== null &&
				"error" in message &&
				message.error instanceof Error &&
				"request" in message &&
				typeof message.request === "object" &&
				message.request !== null &&
				"origin" in message.request &&
				message.request.origin === url
			) {
				transportErrors.push(message.error);
			}
		};
		requestErrors.subscribe(recordError);
		try {
			await store.init();
			state.reset = true;
			// Observe genuine Undici errors without replacing the transport. Await the
			// rejection immediately so even a failed assertion cannot reject unhandled.
			const failure: unknown = await store
				.searchL1Vector(new Float32Array([1]), 5, "absent")
				.catch((error: unknown) => error);
			if (!(failure instanceof Error)) throw new Error("Remote retrieval unexpectedly succeeded");
			expect(state.resetRequests).toBe(3);
			expect(transportErrors).toHaveLength(3);
			expect(failure).toMatchObject({
				code: "memory_search_failed",
				cause: expect.objectContaining({ code: "UND_ERR_SOCKET" }),
			});
			expect(failure.cause).toBe(transportErrors.at(-1));
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(transportErrors[2].message));
		} finally {
			requestErrors.unsubscribe(recordError);
			await close();
		}
	});
});
