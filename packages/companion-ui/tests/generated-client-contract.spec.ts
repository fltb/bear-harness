import { createCompanionClient } from "@bear-harness/companion-client";
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

	it("keeps one invalidation subscription open, validates shared cache keys, and unsubscribes", async () => {
		let receive!: (batch: unknown) => void;
		const stop = vi.fn();
		const invoke = vi.fn();
		const listenInvalidations = vi.fn((callback) => {
			receive = callback;
			return stop;
		});
		const client = createCompanionClient({ invoke, listenInvalidations });
		const controller = new AbortController();
		const stream = client.invalidations.stream(controller.signal)[Symbol.asyncIterator]();
		const first = stream.next();
		receive({
			notices: [{ keys: [["providers"]] }],
		});
		expect((await first).value).toEqual({ keys: [["providers"]] });
		const next = stream.next();
		receive({
			notices: [{ keys: [["settings"]] }],
		});
		expect((await next).value?.keys).toEqual([["settings"]]);
		expect(listenInvalidations).toHaveBeenCalledTimes(1);
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
			listenInvalidations: (receive) => {
				receive({ notices: [{ keys: [] }] });
				return stop;
			},
		});
		await expect(
			client.invalidations.stream(new AbortController().signal)[Symbol.asyncIterator]().next(),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(stop).toHaveBeenCalledOnce();
		const invoke = vi.fn();
		await expect(
			createCompanionClient({ invoke })
				.invalidations.stream(new AbortController().signal)
				[Symbol.asyncIterator]()
				.next(),
		).rejects.toThrow("does not support invalidation push");
		expect(invoke).not.toHaveBeenCalled();
	});
});
