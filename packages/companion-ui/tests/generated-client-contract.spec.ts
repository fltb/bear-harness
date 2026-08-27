import {
	createCompanionClient,
	isMutationResponse,
	responseRevision,
} from "@bear-harness/companion-client";
import { QueryClient } from "@tanstack/solid-query";
import { describe, expect, it, vi } from "vitest";
import { withRpcMutations } from "../src/stores/mutation-client.js";

describe("schema-derived companion client", () => {
	it("tracks imperative commands as mutations without caching request secrets or retrying", async () => {
		const cache = new QueryClient();
		const pending = Promise.withResolvers<unknown>();
		const transport = vi.fn(() => pending.promise);
		const client = withRpcMutations(createCompanionClient({ invoke: transport }), cache);
		const result = client.provider.setApiKey({ providerId: "test", apiKey: "fake-secret" });
		const mutation = cache.getMutationCache().getAll()[0];
		expect(mutation?.state.status).toBe("pending");
		expect(mutation?.state.variables).toBeUndefined();
		pending.resolve({ ok: false, error: { kind: "unavailable", reason: "test_failure" } });
		await expect(result).resolves.toEqual({
			ok: false,
			error: { kind: "unavailable", reason: "test_failure" },
		});
		expect(mutation?.state.status).toBe("error");
		expect(transport).toHaveBeenCalledTimes(1);
		cache.clear();
	});

	it("binds a reused client to its new QueryClient without double dispatch", async () => {
		const first = new QueryClient();
		const second = new QueryClient();
		const pending = Promise.withResolvers<unknown>();
		const transport = vi.fn(() => pending.promise);
		const original = createCompanionClient({ invoke: transport });
		const client = withRpcMutations(withRpcMutations(original, first), second);
		const result = client.provider.setApiKey({ providerId: "test", apiKey: "fake-secret" });
		expect(first.getMutationCache().getAll()).toHaveLength(0);
		expect(second.getMutationCache().getAll()).toHaveLength(1);
		pending.resolve({ ok: true, data: {} });
		await result;
		expect(transport).toHaveBeenCalledTimes(1);
		first.clear();
		second.clear();
	});

	it("preserves nested read provenance and distinguishes command completion watermarks", async () => {
		const sync = { epoch: "host-a", revision: 8 };
		const client = createCompanionClient({
			invoke: async (endpoint) => ({
				ok: true,
				sync,
				data: endpoint.operation === "query" ? { entries: [] } : { ready: true },
			}),
		});
		const read = await client.memory.list();
		if (!read.ok) throw new Error("expected read success");
		expect(responseRevision(read.data.entries)).toEqual(sync);
		expect(isMutationResponse(read.data)).toBe(false);
		const command = await client.memory.configureLocalEmbedding({ provider: "none" });
		if (!command.ok) throw new Error("expected command success");
		expect(isMutationResponse(command.data)).toBe(true);
	});

	it("uses endpoint objects and rejects malformed Host success data", async () => {
		const invoke = vi.fn(async () => ({ ok: true, data: { entries: [{ id: "missing-fields" }] } }));
		const client = createCompanionClient({ invoke });

		await expect(client.memory.search({ query: "remember" })).rejects.toMatchObject({
			name: "ZodError",
		});
		expect(invoke.mock.calls[0]?.[0]).toMatchObject({
			kind: "rpc",
			channel: "memory.search:v1",
		});
	});

	it("rejects invalid requests before transport invocation", async () => {
		const invoke = vi.fn();
		const client = createCompanionClient({ invoke });
		await expect(
			client.memory.search({ query: "test", scope: "invalid" as never }),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(invoke).not.toHaveBeenCalled();
	});
	it("keeps one push subscription open, validates batches, and unsubscribes on abort", async () => {
		let receive!: (batch: unknown) => void;
		const stop = vi.fn();
		const invoke = vi.fn();
		const listen = vi.fn((_cursor, callback) => {
			receive = callback;
			return stop;
		});
		const client = createCompanionClient({ invoke, listen });
		const controller = new AbortController();
		const stream = client.events.stream(12, controller.signal)[Symbol.asyncIterator]();
		const first = stream.next();
		receive({
			events: [
				{ seq: 13, kind: "provider.login_changed", payload: { providerId: "openai-codex" } },
			],
		});
		expect((await first).value).toEqual([
			{ seq: 13, kind: "provider.login_changed", payload: { providerId: "openai-codex" } },
		]);
		const next = stream.next();
		receive({
			events: [
				{
					seq: 14,
					kind: "memory.embedding_download_changed",
					payload: { status: "downloading", downloadedBytes: 32 },
				},
			],
		});
		expect((await next).value?.[0]?.seq).toBe(14);
		expect(listen).toHaveBeenCalledTimes(1);
		expect(invoke).not.toHaveBeenCalled();
		const pending = stream.next();
		controller.abort();
		expect((await pending).done).toBe(true);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed pushed events and never falls back to polling", async () => {
		const stop = vi.fn();
		const client = createCompanionClient({
			invoke: vi.fn(),
			listen: (_cursor, receive) => {
				receive({ events: [{ seq: 1, kind: "provider.login_changed", payload: {} }] });
				return stop;
			},
		});
		await expect(
			client.events.stream(0, new AbortController().signal)[Symbol.asyncIterator]().next(),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(stop).toHaveBeenCalledOnce();
		const invoke = vi.fn();
		await expect(
			createCompanionClient({ invoke })
				.events.stream(0, new AbortController().signal)
				[Symbol.asyncIterator]()
				.next(),
		).rejects.toThrow("does not support event push");
		expect(invoke).not.toHaveBeenCalled();
	});
});
