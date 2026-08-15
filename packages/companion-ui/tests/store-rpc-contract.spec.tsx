import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createCompanionStore } from "../src/stores/companion.js";
import { createTestClient } from "./fixtures.js";

function createStoreWithCleanup(client: ReturnType<typeof createTestClient>["client"]) {
	let dispose = () => undefined;
	let store: ReturnType<typeof createCompanionStore> | undefined;
	createRoot((cleanup) => {
		dispose = cleanup;
		createComponent(QueryClientProvider, {
			client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
			get children() {
				store = createCompanionStore(client);
				return undefined;
			},
		});
	});
	if (!store) throw new Error("store initialization failed");
	return { store, dispose };
}

describe("store RPC contract", () => {
	it("routes the complete settings, memory, provider, story, canon, and work surface", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 1,
					conversation: {
						activeConversationId: "conversation-1",
						conversations: [],
						messages: [],
					},
				},
			}),
		);
		client.commission.launch = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					runId: "run-1",
					commissionId: "commission-1",
					executorProfile: "pi-product-managed",
					status: "running" as const,
				},
			}),
		);
		const runResult = {
			id: "run-1",
			commissionId: "commission-1",
			executorProfile: "pi-product-managed",
			status: "running" as const,
		};
		client.run.cancel = vi.fn(() => Promise.resolve({ ok: true as const, data: runResult }));
		client.run.respondPermission = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: runResult }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("conversation-1"));

			await store.settings.get();
			await store.settings.set({
				relationshipMemoryEnabled: true,
				textFallback: { providerId: "relay", modelId: "text-model" },
				multimodalFallback: { providerId: "relay", modelId: "vision-model" },
			});
			await store.memory.listCandidates();
			await store.memory.decideCandidate(
				"candidate-1",
				"approve_edited",
				"edited memory",
				"relationship",
			);
			await store.memory.search("query", "relationship");
			await store.memory.list("relationship");
			await store.memory.pin("memory-1", true);
			await store.memory.exclude("memory-1", true);
			await store.memory.edit("memory-1", "new memory");
			await store.memory.forget("memory-1");

			await store.provider.list();
			await store.provider.customUpsert({
				providerId: "relay",
				name: "Relay",
				baseUrl: "https://relay.example/v1",
				modelId: "model",
				apiKey: "key",
			});
			await store.provider.overrideBaseUrl({
				providerId: "relay",
				baseUrl: "https://override.example/v1",
			});
			await store.provider.setApiKey("relay", "key");
			await store.provider.login("oauth-provider");
			await store.provider.loginStatus("oauth-provider");
			await store.provider.loginAnswer("oauth-provider", "answer");
			await store.provider.logout("oauth-provider");

			await store.voice.list();
			await store.voice.pin("relay", "model", "Relay model");
			await store.voice.switch("stack-1", "global");
			await store.characters.list();
			await store.characters.activate("role-2");

			await store.story.list();
			await store.story.apply("AU change", "branch");
			await store.story.revert("change-1");
			await store.story.reset();
			await store.story.resolveProposal("proposal-1", true);

			await store.canon.listSources();
			await store.canon.addSource("source.txt", "source text");
			await store.canon.search("canon query");
			await store.canon.removeSource("source-1");
			await store.canon.listModules();
			await store.canon.upsertModule({
				kind: "root",
				title: "Recall",
				instructions: "Recall canon",
				sourceChunkIds: ["chunk-1"],
			});
			await store.canon.deleteModule("module-1");

			await store.commission.list();
			await store.commission.draft({
				conversationId: "conversation-1",
				title: "Work",
				description: "Do work",
			});
			await store.commission.approve("commission-1", "hash");
			await store.commission.reject("commission-1");
			await store.commission.launch("commission-1", "pi-product-managed");
			await store.run.list();
			await store.run.steer("run-1", "continue carefully");
			await store.run.cancel("run-1");
			await store.run.respondPermission("run-1", "permission-1", "allow");
			await store.artifact.list();

			expect(client.settings.set).toHaveBeenCalled();
			expect(client.memory.edit).toHaveBeenCalledWith("memory-1", "new memory");
			expect(client.provider.overrideBaseUrl).toHaveBeenCalledWith({
				providerId: "relay",
				baseUrl: "https://override.example/v1",
			});
			expect(client.story.applyChange).toHaveBeenCalledWith(
				"AU change",
				"branch",
				"conversation-1",
				undefined,
			);
			expect(client.canon.upsertModule).toHaveBeenCalled();
			expect(client.commission.launch).toHaveBeenCalledWith("commission-1", "pi-product-managed");
		} finally {
			dispose();
		}
	});

	it("merges domain events and invalidates every affected projection", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { eventSeq: 0, conversation: { messages: [] } } }),
		);
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription > 1) return new Promise<never>(() => undefined);
			const kinds = [
				[
					"character.scene_changed",
					{ conversationId: "conversation-2", sceneId: "room", visualState: "thinking" },
				],
				["conversation.created", { conversationId: "conversation-2" }],
				["conversation.branched", { branchId: "branch-2" }],
				["companion.state_changed", { state: "running" }],
				[
					"run.needs_user",
					{
						runId: "run-1",
						requestId: "permission-1",
						prompt: "Allow?",
						options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
					},
				],
				["run.result_adopted", { runId: "run-1" }],
				["memory.changed", {}],
				["provider.changed", {}],
				["voice.changed", {}],
				["commission.changed", {}],
				["artifact.created", {}],
				["story.changed", {}],
				["character.changed", {}],
				["settings.changed", {}],
				["diagnostics.updated", {}],
			] as const;
			return Promise.resolve({
				ok: true as const,
				data: {
					events: kinds.map(([kind, payload], index) => ({ seq: index + 1, kind, payload })),
				},
			});
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("conversation-2"));
			expect(store.characterRuntimeByConversation["conversation-2"]).toEqual({
				sceneId: "room",
				visualState: "thinking",
			});
			expect(store.run.pendingPermissions()).toEqual([
				expect.objectContaining({ runId: "run-1", requestId: "permission-1" }),
			]);
			await waitFor(() => expect(client.provider.list).toHaveBeenCalled());
			await waitFor(() => expect(client.voice.list).toHaveBeenCalled());
			await waitFor(() => expect(client.memory.listCandidates).toHaveBeenCalled());
			await waitFor(() => expect(client.story.listChanges).toHaveBeenCalled());
			await waitFor(() => expect(client.character.list).toHaveBeenCalled());
		} finally {
			dispose();
		}
	});
});
