import { QueryClient } from "@tanstack/solid-query";
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionStore } from "../src/stores/companion.js";
import type { RunGetResponse, RunInfo } from "../src/stores/ipc.js";
import { invoke } from "../src/stores/ipc.js";
import { queryKeys } from "../src/stores/rpc-query.js";
import { createRunApi } from "../src/stores/run-api.js";
import { createShellWorkflowStore } from "../src/stores/shell-workflows.js";
import { createTestClient, THEMED_CHARACTER } from "./fixtures.js";

const queryClients: QueryClient[] = [];
const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	for (const client of queryClients.splice(0)) client.clear();
});

const run: RunInfo = {
	id: "run-one",
	conversationId: "conversation-one",
	triggerEntryId: "entry-one",
	executorProfile: "pi-default",
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
const detail: RunGetResponse = {
	run,
	instruction: "Inspect the project",
	inputPaths: [],
	evidence: [],
};

function createHarness(
	refreshRuns = vi.fn(async () => undefined),
	characterId: () => string | undefined = () => "character-one",
) {
	const { client } = createTestClient();
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClients.push(queryClient);
	client.run.list = vi.fn(async () => ({ ok: true as const, data: { runs: [run] } }));
	client.run.get = vi.fn(async () => ({ ok: true as const, data: detail }));
	client.run.steer = vi.fn(async () => ({ ok: true as const, data: { outcome: "sent" as const } }));
	client.run.interrupt = vi.fn(async () => ({
		ok: true as const,
		data: { ...run, status: "interrupted" as const },
	}));
	client.run.cancel = vi.fn(async () => ({
		ok: true as const,
		data: { ...run, status: "cancelled" as const },
	}));
	const onRefreshError = vi.fn();
	const api = createRunApi({
		client,
		queryClient,
		characterId,
		runsRequest: (request) => invoke(client, () => client.run.list(request)),
		activeRuns: () => [run],
		refreshRuns,
		onRefreshError,
	});
	return { api, client, queryClient, onRefreshError, refreshRuns };
}

function createWorkflow() {
	return createRoot((dispose) => {
		disposers.push(dispose);
		const [character, setCharacter] = createSignal(THEMED_CHARACTER);
		const [conversationId, setConversationId] = createSignal<string | null>("conversation-two");
		const [runs, setRuns] = createSignal<RunInfo[]>([run]);
		const selectConversation = vi.fn(async (id: string) => {
			setConversationId(id);
		});
		const sendMessage = vi.fn(async (_text: string) => undefined);
		const store = {
			get character() {
				return character();
			},
			get activeConversationId() {
				return conversationId();
			},
			get runs() {
				return runs();
			},
			errorMetadata: null,
			run: { pendingPermissions: () => [] },
			selectConversation,
			sendMessage,
		} as unknown as CompanionStore;
		const workflow = createShellWorkflowStore({
			store,
			currentLocale: () => "en",
			translate: ((key: string) => key) as never,
		});
		return { workflow, setCharacter, setConversationId, setRuns, selectConversation, sendMessage };
	});
}

describe("run store API", () => {
	it("keeps unscoped observers empty and rejects manual refetch until their IDs are available", async () => {
		const [characterId, setCharacterId] = createSignal<string>();
		const [runId, setRunId] = createSignal<string>();
		const { api, client } = createHarness(undefined, characterId);
		const observers = createRoot((dispose) => {
			disposers.push(dispose);
			return { detail: api.observeDetail(runId), history: api.observeHistory() };
		});
		expect(observers.detail.data).toBeUndefined();
		expect(observers.history.data).toBeUndefined();
		expect(client.run.get).not.toHaveBeenCalled();
		expect(client.run.list).not.toHaveBeenCalled();
		for (const observer of [observers.detail, observers.history]) {
			const result = await observer.refetch();
			expect(result.isError).toBe(true);
			expect(result.data).toBeUndefined();
		}
		expect(client.run.get).not.toHaveBeenCalled();
		expect(client.run.list).not.toHaveBeenCalled();

		setCharacterId("character-one");
		await vi.waitFor(() => expect(observers.history.data).toEqual({ runs: [run] }));
		expect((await observers.detail.refetch()).isError).toBe(true);
		expect(client.run.get).not.toHaveBeenCalled();
		setRunId(run.id);
		await vi.waitFor(() => expect(observers.detail.data).toEqual(detail));
	});

	it("keeps paginated history and evidence separate from the unfinished projection", async () => {
		const { api, client, queryClient } = createHarness();
		await api.list();
		client.run.list = vi.fn(async () => ({
			ok: true as const,
			data: { runs: [], nextCursor: "older" },
		}));
		await api.list({ scope: "history", cursor: "page-two" });
		expect(queryClient.getQueryData(queryKeys.activeRuns("character-one"))).toEqual({
			runs: [run],
		});
		await api.get(run.id);
		client.run.get = vi.fn(async () => ({
			ok: true as const,
			data: { ...detail, nextCursor: "more" },
		}));
		await api.get(run.id, "older-evidence");
		expect(queryClient.getQueryData(queryKeys.runDetail("character-one", run.id))).toEqual(detail);
		expect(
			queryClient.getQueryData(queryKeys.runDetail("character-one", run.id, "older-evidence")),
		).toMatchObject({ nextCursor: "more" });
	});

	it("does not replace authoritative task state while control is pending or rejected", async () => {
		const { api, client, queryClient, refreshRuns } = createHarness();
		await api.list();
		const { promise, reject } = Promise.withResolvers<never>();
		client.run.cancel = vi.fn(() => promise);
		const pending = api.cancel(run.id);
		expect(queryClient.getQueryData(queryKeys.activeRuns("character-one"))).toEqual({
			runs: [run],
		});
		reject(new Error("controller unavailable"));
		await expect(pending).rejects.toThrow("controller unavailable");
		expect(queryClient.getQueryData(queryKeys.activeRuns("character-one"))).toEqual({
			runs: [run],
		});
		expect(refreshRuns).not.toHaveBeenCalled();
	});

	it("invalidates open detail after an accepted control without inventing execution state", async () => {
		const { api, queryClient } = createHarness();
		const key = queryKeys.runDetail("character-one", run.id);
		queryClient.setQueryData(key, detail);
		await api.steer(run.id, "Focus on tests");
		expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryData(key)).toEqual(detail);
	});

	it("replaces inspected task capabilities from a confirmed control without touching another character", async () => {
		const { api, queryClient } = createHarness();
		const currentKey = queryKeys.runDetail("character-one", run.id);
		const otherKey = queryKeys.runDetail("character-two", run.id);
		const runningDetail = { ...detail, run: { ...run, actions: ["interrupt" as const] } };
		queryClient.setQueryData(currentKey, runningDetail);
		queryClient.setQueryData(otherKey, runningDetail);
		await api.interrupt(run.id);
		expect(queryClient.getQueryData<RunGetResponse>(currentKey)?.run.status).toBe("interrupted");
		expect(queryClient.getQueryData<RunGetResponse>(currentKey)?.run.actions).toBeUndefined();
		expect(queryClient.getQueryData(otherKey)).toEqual(runningDetail);
	});

	it("reports refresh failure separately from an accepted command", async () => {
		const { api, onRefreshError } = createHarness(
			vi.fn(async () => {
				throw new Error("refresh failed");
			}),
		);
		await expect(api.interrupt(run.id)).resolves.toMatchObject({ status: "interrupted" });
		await vi.waitFor(() =>
			expect(onRefreshError).toHaveBeenCalledWith(
				expect.objectContaining({ message: "refresh failed" }),
			),
		);
	});

	it("propagates exact RPC control failures", async () => {
		const { api, client, refreshRuns } = createHarness();
		client.run.cancel = vi.fn(async () => ({
			ok: false as const,
			error: { kind: "conflict" as const, reason: "already_finished" },
		}));
		await expect(api.cancel(run.id)).rejects.toMatchObject({
			name: "IpcInvocationError",
			kind: "conflict",
			reason: "already_finished",
		});
		expect(refreshRuns).not.toHaveBeenCalled();
	});
});

describe("task workflow scope", () => {
	it("keeps paused tasks discoverable across conversations and resets selection only for a new character", () => {
		const { workflow, setRuns, setConversationId, setCharacter } = createWorkflow();
		setRuns([
			{ ...run, status: "interrupted" },
			{ ...run, id: "done", status: "completed" },
		]);
		expect(workflow.activeRuns().map((item) => item.id)).toEqual([run.id]);
		workflow.openTask(run.id);
		expect(workflow.queueOpen()).toBe(true);
		setConversationId("conversation-three");
		expect(workflow.selectedTaskId()).toBe(run.id);
		setCharacter({ ...THEMED_CHARACTER });
		expect(workflow.selectedTaskId()).toBe(run.id);
		setCharacter({ ...THEMED_CHARACTER, id: "other-character" });
		expect(workflow.selectedTaskId()).toBeNull();
	});

	it("opens an older task artifact only after original-conversation navigation succeeds", async () => {
		const { workflow, selectConversation, setConversationId, setRuns } = createWorkflow();
		const historic: RunInfo = {
			...run,
			artifacts: [
				{
					id: "artifact-one",
					name: "result.txt",
					mime: "text/plain",
					bytes: 10,
					status: "verified",
					sha256: "a".repeat(64),
					createdAt: "2026-09-06T00:00:00.000Z",
				},
			],
		};
		setRuns([]);
		const { promise, resolve } = Promise.withResolvers<void>();
		selectConversation.mockImplementation(async (id) => {
			await promise;
			setConversationId(id);
		});
		const pending = workflow.openRunArtifact(historic, "artifact-one");
		expect(workflow.selectedArtifact()).toBeUndefined();
		resolve();
		await pending;
		expect(workflow.selectedArtifact()?.run.id).toBe(run.id);
		setRuns([{ ...historic, artifacts: [] }]);
		expect(workflow.selectedArtifact()?.artifact.id).toBe("artifact-one");
		setRuns([historic]);
		expect(workflow.selectedArtifact()?.artifact.id).toBe("artifact-one");
		setConversationId(null);
		expect(workflow.selectedArtifact()?.artifact.id).toBe("artifact-one");
		setConversationId(run.conversationId);
		expect(workflow.selectedArtifact()?.artifact.id).toBe("artifact-one");
		setConversationId("another-conversation");
		expect(workflow.selectedArtifact()).toBeUndefined();
	});

	it("retains failed instruction drafts and never sends to the wrong conversation after failed navigation", async () => {
		const { workflow, selectConversation, sendMessage } = createWorkflow();
		const state = workflow.runActionState(`${run.id}:again`);
		state.setSteerText("Try again with a smaller scope");
		selectConversation.mockRejectedValue(new Error("conversation unavailable"));
		const succeeded = await workflow.runRunAction(`${run.id}:again`, () =>
			workflow.requestRunAgain(run, state.steerText()),
		);
		expect(succeeded).toBe(false);
		expect(state.steerText()).toBe("Try again with a smaller scope");
		expect(state.error()).toBe("conversation unavailable");
		expect(sendMessage).not.toHaveBeenCalled();
	});
});
