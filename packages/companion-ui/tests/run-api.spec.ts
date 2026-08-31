import { QueryClient } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunInfo } from "../src/stores/ipc.js";
import { createRunApi } from "../src/stores/run-api.js";
import { createTestClient } from "./fixtures.js";

const queryClients: QueryClient[] = [];

afterEach(() => {
	for (const client of queryClients.splice(0)) client.clear();
});

const run: RunInfo = {
	id: "run-one",
	conversationId: "conversation-one",
	triggerEntryId: "entry-one",
	executorProfile: "codex",
	title: "Test run",
	status: "needs_user",
	artifacts: [],
	evidence: [],
	permission: {
		runId: "run-one",
		requestId: "permission-one",
		prompt: "Continue?",
		options: [{ optionId: "yes", kind: "allow", name: "Allow" }],
	},
};

function createHarness(refreshRuns = vi.fn(async () => undefined)) {
	const { client } = createTestClient();
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClients.push(queryClient);
	client.run.list = vi.fn(() => Promise.resolve({ ok: true as const, data: { runs: [run] } }));
	client.run.steer = vi.fn(() => Promise.resolve({ ok: true as const, data: run }));
	client.run.interrupt = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { ...run, status: "interrupted" as const } }),
	);
	client.run.resume = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { ...run, status: "running" as const } }),
	);
	client.run.cancel = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { ...run, status: "cancelled" as const } }),
	);
	client.run.respondPermission = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { ...run, status: "running" as const } }),
	);
	const onRefreshError = vi.fn();
	const api = createRunApi({
		client,
		queryClient,
		runsRequest: async () => (await client.run.list()).data,
		activeRuns: () => [run, { ...run, id: "run-two", permission: undefined }],
		refreshRuns,
		onRefreshError,
	});
	return { api, client, onRefreshError, refreshRuns };
}

describe("run store API", () => {
	it("lists runs, projects only pending permissions, and routes steering", async () => {
		const { api, client, refreshRuns } = createHarness();

		expect(await api.list()).toEqual({ runs: [run] });
		expect(api.pendingPermissions()).toEqual([run.permission]);
		await api.steer(run.id, "Focus on tests");
		expect(client.run.steer).toHaveBeenCalledWith({
			runId: run.id,
			instruction: "Focus on tests",
		});
		expect(refreshRuns).not.toHaveBeenCalled();
	});

	it("returns every lifecycle result and requests a background refresh", async () => {
		const { api, client, refreshRuns } = createHarness();

		expect((await api.interrupt(run.id)).status).toBe("interrupted");
		expect((await api.resume(run.id)).status).toBe("running");
		expect((await api.cancel(run.id)).status).toBe("cancelled");
		expect((await api.respondPermission(run.id, "permission-one", "yes")).status).toBe("running");
		expect(client.run.respondPermission).toHaveBeenCalledWith({
			runId: run.id,
			requestId: "permission-one",
			optionId: "yes",
		});
		expect(refreshRuns).toHaveBeenCalledTimes(4);
	});

	it("reports background refresh failures without rejecting a successful command", async () => {
		const refreshRuns = vi.fn(() => Promise.reject(new Error("refresh failed")));
		const { api, onRefreshError } = createHarness(refreshRuns);

		await expect(api.interrupt(run.id)).resolves.toMatchObject({ status: "interrupted" });
		await vi.waitFor(() =>
			expect(onRefreshError).toHaveBeenCalledWith(
				expect.objectContaining({ message: "refresh failed" }),
			),
		);
	});

	it("propagates command failures and does not refresh", async () => {
		const { api, client, refreshRuns } = createHarness();
		client.run.cancel = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "conflict" as const, reason: "already_finished" },
			}),
		);

		await expect(api.cancel(run.id)).rejects.toMatchObject({
			name: "IpcInvocationError",
			kind: "conflict",
			reason: "already_finished",
		});
		expect(refreshRuns).not.toHaveBeenCalled();
	});
});
