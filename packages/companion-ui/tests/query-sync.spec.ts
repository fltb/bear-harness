import { createCompanionClient, withResponseRevision } from "@bear-harness/companion-client";
import { CancelledError, QueryClient } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acceptsQueryValue,
	commitQueryValue,
	invalidateCommittedQueries,
	readQueryValue,
} from "../src/stores/query-sync.js";
import { refreshRpcQuery } from "../src/stores/rpc-query.js";

const clients: QueryClient[] = [];

afterEach(() => {
	for (const client of clients.splice(0)) client.clear();
});

function queryClient() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	clients.push(client);
	return client;
}

function revised<T extends object>(value: T, epoch: string, revision: number): T {
	return withResponseRevision(value, { epoch, revision });
}

describe("query revision coordinator", () => {
	it("accepts unversioned fixtures only before an epoch and rejects stale or retired values", () => {
		const client = queryClient();
		const key = ["domain", "one"] as const;

		expect(commitQueryValue(client, key, { value: "fixture" })).toBe(true);
		expect(client.getQueryData(key)).toEqual({ value: "fixture" });
		expect(commitQueryValue(client, key, revised({ value: "one" }, "epoch-one", 1))).toBe(true);
		expect(commitQueryValue(client, key, revised({ value: "same" }, "epoch-one", 1))).toBe(true);
		expect(acceptsQueryValue(client, key, { value: "late fixture" })).toBe(false);
		expect(acceptsQueryValue(client, key, revised({ value: "stale" }, "epoch-one", 0))).toBe(false);
		expect(commitQueryValue(client, key, revised({ value: "stale" }, "epoch-one", 0))).toBe(false);

		client.setQueryData(["other"], { retained: true });
		expect(commitQueryValue(client, key, revised({ value: "two" }, "epoch-two", 2))).toBe(true);
		expect(client.getQueryData(["other"])).toBeUndefined();
		expect(acceptsQueryValue(client, key, revised({ value: "retired" }, "epoch-one", 9))).toBe(
			false,
		);
	});

	it("rejects mutation watermarks and late responses from an older request incarnation", async () => {
		const mutationClient = createCompanionClient({
			invoke: async () => ({
				ok: true,
				data: {},
				sync: { epoch: "mutation-epoch", revision: 1 },
			}),
		});
		const mutation = await mutationClient.conversation.archive({
			id: "conversation-one",
			archived: true,
		});
		if (!mutation.ok) throw new Error("unexpected mutation failure");
		expect(acceptsQueryValue(queryClient(), ["mutation"], mutation.data)).toBe(false);

		const first = Promise.withResolvers<unknown>();
		const second = Promise.withResolvers<unknown>();
		let request = 0;
		const readClient = createCompanionClient({
			invoke: () => (++request === 1 ? first.promise : second.promise),
		});
		const olderRequest = readClient.conversation.list();
		const newerRequest = readClient.conversation.list();
		second.resolve({
			ok: true,
			data: { sessions: [] },
			sync: { epoch: "newer-epoch", revision: 2 },
		});
		const newer = await newerRequest;
		first.resolve({
			ok: true,
			data: { sessions: [] },
			sync: { epoch: "older-epoch", revision: 1 },
		});
		const older = await olderRequest;
		if (!newer.ok || !older.ok) throw new Error("unexpected query failure");
		const client = queryClient();
		expect(acceptsQueryValue(client, ["sessions"], newer.data)).toBe(true);
		expect(acceptsQueryValue(client, ["sessions"], older.data)).toBe(false);
	});

	it("retries stale reads, falls back to a sufficiently new cache, and fails after three misses", async () => {
		const client = queryClient();
		const retryKey = ["retry"] as const;
		commitQueryValue(client, retryKey, revised({ value: 1 }, "epoch", 1));
		invalidateCommittedQueries(client, { epoch: "epoch", revision: 3 }, () => true);
		const request = vi
			.fn<() => Promise<{ value: number }>>()
			.mockResolvedValueOnce(revised({ value: 2 }, "epoch", 2))
			.mockResolvedValueOnce(revised({ value: 3 }, "epoch", 3));
		expect(await readQueryValue(client, retryKey, request)).toEqual({ value: 3 });
		expect(request).toHaveBeenCalledTimes(2);

		const fallbackKey = ["fallback"] as const;
		const cached = revised({ value: 5 }, "epoch", 5);
		commitQueryValue(client, fallbackKey, cached);
		expect(
			await readQueryValue(client, fallbackKey, async () => revised({ value: 4 }, "epoch", 4)),
		).toBe(cached);

		commitQueryValue(client, ["epoch-switch"], revised({ value: 6 }, "epoch-two", 6));
		const miss = vi.fn(async () => revised({ value: 0 }, "epoch", 100));
		await expect(readQueryValue(client, ["miss"], miss)).rejects.toThrow(
			"Host query could not reach the required committed revision",
		);
		expect(miss).toHaveBeenCalledTimes(3);
	});

	it("cancels a read if cache removal retires its generation", async () => {
		const client = queryClient();
		const key = ["removed"] as const;
		commitQueryValue(client, key, revised({ value: 1 }, "epoch", 1));

		await expect(
			readQueryValue(client, key, async () => {
				client.removeQueries({ queryKey: key, exact: true });
				return revised({ value: 2 }, "epoch", 2);
			}),
		).rejects.toBeInstanceOf(CancelledError);
	});

	it("retries a refresh whose revision was retired by a newer Host epoch", async () => {
		const client = queryClient();
		const key = ["refresh-race"] as const;
		commitQueryValue(client, key, revised({ value: 1 }, "old-epoch", 1));
		commitQueryValue(client, ["new-epoch"], revised({ value: 2 }, "new-epoch", 2));
		const request = vi
			.fn<() => Promise<{ value: number }>>()
			.mockResolvedValueOnce(revised({ value: 1 }, "old-epoch", 9))
			.mockResolvedValue(revised({ value: 2 }, "new-epoch", 2));

		await expect(refreshRpcQuery({ client, key, request })).resolves.toEqual({ value: 2 });
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("invalidates only tracked matching queries in the current epoch", async () => {
		const client = queryClient();
		const tracked = ["tracked"] as const;
		const untracked = ["untracked"] as const;
		commitQueryValue(client, tracked, revised({ value: 5 }, "epoch", 5));
		client.setQueryData(untracked, { value: 1 });
		const invalidate = vi.spyOn(client, "invalidateQueries");

		invalidateCommittedQueries(client, { epoch: "other", revision: 9 }, () => true);
		invalidateCommittedQueries(client, { epoch: "epoch", revision: 4 }, () => true);
		invalidateCommittedQueries(client, { epoch: "epoch", revision: 6 }, () => false);
		expect(invalidate).not.toHaveBeenCalled();

		invalidateCommittedQueries(client, { epoch: "epoch", revision: 6 }, (key) =>
			key.includes("tracked"),
		);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith(
			{ queryKey: tracked, exact: true, refetchType: "all" },
			{ cancelRefetch: false },
		);

		client.setQueryData(tracked, { value: "local-success" });
		await vi.waitFor(() => expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(2));
		client.removeQueries({ queryKey: tracked, exact: true });
		invalidateCommittedQueries(client, { epoch: "epoch", revision: 7 }, () => true);
	});
});
