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
	it("does not let a delayed boot snapshot erase a model enabled during startup", async () => {
		const { client } = createTestClient();
		let resolveSnapshot:
			| ((value: Awaited<ReturnType<typeof client.snapshot.get>>) => void)
			| undefined;
		client.snapshot.get = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveSnapshot = resolve;
				}),
		);
		const configured = {
			providerId: "relay",
			modelId: "fast",
			label: "Fast",
			supportsImages: false,
			createdAt: "2026-01-01",
		};
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { models: [configured] } }),
		);
		client.model.defaultsGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					reply: { providerId: "relay", modelId: "fast" },
					vision: { mode: "auto" as const },
				},
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await store.model.enable("relay", "fast", "Fast");
			await store.model.list();
			client.conversation.create = vi.fn(() =>
				Promise.resolve({ ok: true as const, data: { id: "conversation-new" } }),
			);
			client.model.routeGet = vi.fn(({ conversationId }) =>
				Promise.resolve({
					ok: true as const,
					data: {
						conversationId,
						selected: { providerId: "relay", modelId: "fast" },
					},
				}),
			);
			await store.createConversation("New conversation");
			await waitFor(() =>
				expect(store.model.data().defaults.reply).toEqual({
					providerId: "relay",
					modelId: "fast",
				}),
			);
			resolveSnapshot?.({
				ok: true,
				data: {
					eventSeq: 1,
					conversation: {
						activeConversationId: "conversation-old",
						messages: [
							{
								id: "old-message",
								role: "user",
								createdAt: "2026-01-01T00:00:00.000Z",
								versions: [
									{
										id: "old-version",
										role: "user",
										content: "stale conversation body",
										editedByUser: false,
										createdAt: "2026-01-01T00:00:00.000Z",
										adopted: true,
									},
								],
							},
						],
					},
					model: { pool: { models: [] }, defaults: { vision: { mode: "auto" } } },
				},
			});
			await waitFor(() => expect(store.snapshot.eventSeq()).toBe(1));
			expect(store.activeConversationId).toBe("conversation-new");
			expect(store.activeMessages).toEqual([]);
			expect(store.model.models()).toEqual([configured]);
			expect(store.model.data().defaults.reply).toEqual({
				providerId: "relay",
				modelId: "fast",
			});
		} finally {
			dispose();
		}
	});

	it("keeps scoped routes and loads the Host-applied default after creating a conversation", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 1,
					conversation: { activeConversationId: "conversation-1", messages: [] },
					model: {
						pool: {
							models: [
								{
									providerId: "relay",
									modelId: "fast",
									label: "Fast",
									supportsImages: false,
									createdAt: "2026-01-01",
								},
							],
						},
						defaults: { vision: { mode: "auto" } },
						route: {
							conversationId: "conversation-1",
							selected: { providerId: "relay", modelId: "fast" },
						},
					},
				},
			}),
		);
		client.model.routeGet = vi.fn(({ conversationId }) =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversationId,
					selected:
						conversationId === "conversation-2"
							? { providerId: "e2e-rule", modelId: "rule-model" }
							: { providerId: "relay", modelId: "fast" },
				},
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.model.selectedValue()).toBe("relay:fast"));
			await store.model.list();
			expect(store.model.selectedValue()).toBe("relay:fast");
			client.conversation.create = vi.fn(() =>
				Promise.resolve({ ok: true as const, data: { id: "conversation-2" } }),
			);
			await store.createConversation("New conversation");
			expect(store.model.selectedValue()).toBe("e2e-rule:rule-model");
			expect(client.model.routeGet).toHaveBeenCalledWith({ conversationId: "conversation-2" });
		} finally {
			dispose();
		}
	});

	it("invalidates and projects a refreshed provider list through its query key", async () => {
		const { client } = createTestClient();
		const provider = {
			id: "relay",
			name: "Relay",
			authType: "api_key" as const,
			credentialStatus: "stored" as const,
			availableModels: [],
			unavailable: [],
		};
		client.provider.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { providers: [provider] } }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await store.provider.list();
			await waitFor(() => expect(store.provider.providers()).toEqual([provider]));
		} finally {
			dispose();
		}
	});

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
		client.run.interrupt = vi.fn(() => Promise.resolve({ ok: true as const, data: runResult }));
		client.run.resume = vi.fn(() => Promise.resolve({ ok: true as const, data: runResult }));
		client.run.respondPermission = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: runResult }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("conversation-1"));

			await store.settings.get();
			await store.settings.set({
				relationshipMemoryEnabled: true,
			});
			await store.memory.capture("entry-1");
			await store.memory.search("query", "relationship");
			await store.memory.list({ scope: "relationship" });
			await store.memory.edit("memory-1", "new memory");
			await store.memory.forget("memory-1");
			await store.memory.exclude("memory-1", true);
			await store.memory.listCandidates();
			await store.memory.listCandidates("pending");
			await store.memory.approveCandidate("candidate-1", "edited", "scene");
			await store.memory.rejectCandidate("candidate-1");

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

			await store.model.list("conversation-1");
			await store.model.enable("relay", "model", "Relay model");
			await store.model.select("conversation-1", "relay", "model");
			await store.model.disable("relay", "model");
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
				triggerMessageId: "message-1",
				title: "Work",
				description: "Do work",
			});
			await store.commission.approve("commission-1", "hash");
			await store.commission.reject("commission-1");
			await store.commission.launch("commission-1", "pi-product-managed");
			await store.run.list();
			await store.run.steer("run-1", "continue carefully");
			await store.run.interrupt("run-1");
			await store.run.resume("run-1");
			await store.run.cancel("run-1");
			await store.run.respondPermission("run-1", "permission-1", "allow");
			await store.artifact.list();

			expect(client.settings.set).toHaveBeenCalled();
			expect(client.memory.capture).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				entryId: "entry-1",
			});
			expect(client.memory.search).toHaveBeenCalledWith({
				query: "query",
				scope: "relationship",
			});
			expect(client.memory.list).toHaveBeenCalledWith({ scope: "relationship" });
			expect(client.memory.forget).toHaveBeenCalledWith({ entryId: "memory-1" });
			expect(client.memory.edit).toHaveBeenCalledWith({
				entryId: "memory-1",
				newText: "new memory",
			});
			expect(client.memory.exclude).toHaveBeenCalledWith({ memoryId: "memory-1", excluded: true });
			expect(client.memory.candidatesList).toHaveBeenCalledWith({ status: "pending" });
			expect(client.memory.candidateApprove).toHaveBeenCalledWith({
				candidateId: "candidate-1",
				editedText: "edited",
				decidedScope: "scene",
			});
			expect(client.memory.candidateReject).toHaveBeenCalledWith({ candidateId: "candidate-1" });
			expect(client.provider.overrideBaseUrl).toHaveBeenCalledWith({
				providerId: "relay",
				baseUrl: "https://override.example/v1",
			});
			expect(client.story.applyChange).toHaveBeenCalledWith({
				text: "AU change",
				scope: "branch",
				conversationId: undefined,
				branchId: undefined,
			});
			expect(client.canon.upsertModule).toHaveBeenCalled();
			expect(client.commission.launch).toHaveBeenCalledWith({
				commissionId: "commission-1",
				executorProfile: "pi-product-managed",
			});
			expect(client.run.interrupt).toHaveBeenCalledWith({ runId: "run-1" });
			expect(client.run.resume).toHaveBeenCalledWith({ runId: "run-1" });
		} finally {
			dispose();
		}
	});

	it("merges domain events and invalidates every affected projection", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					conversation: { activeConversationId: "conversation-1", messages: [] },
				},
			}),
		);
		client.model.routeGet = vi.fn(({ conversationId }) =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversationId,
					selected: { providerId: "e2e-rule", modelId: "rule-model" },
				},
			}),
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
				["model.changed", {}],
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
			await waitFor(() => expect(store.activeConversationId).toBe("conversation-1"));
			await waitFor(() => expect(client.conversation.list).toHaveBeenCalled());
			expect(store.activeConversationId).toBe("conversation-1");
			expect(client.model.routeGet).not.toHaveBeenCalledWith({ conversationId: "conversation-2" });
			expect(store.characterRuntimeByConversation["conversation-2"]).toEqual({
				sceneId: "room",
				visualState: "thinking",
			});
			expect(store.run.pendingPermissions()).toEqual([
				expect.objectContaining({ runId: "run-1", requestId: "permission-1" }),
			]);
			await waitFor(() => expect(client.provider.list).toHaveBeenCalled());
			await waitFor(() => expect(client.model.poolGet).toHaveBeenCalled());
			await waitFor(() => expect(client.memory.list).toHaveBeenCalled());
			await waitFor(() => expect(client.story.listChanges).toHaveBeenCalled());
			await waitFor(() => expect(client.character.list).toHaveBeenCalled());
		} finally {
			dispose();
		}
	});
});
