import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { IpcInvocationError } from "../src/lib/ipc.js";
import type { CompanionStore, SettingsData } from "../src/stores/companion.js";
import { invoke, isRecord, payloadString } from "../src/stores/ipc.js";
import {
	createConversationModelSettingsWorkflow,
	createFirstMeetingWorkflow,
	createNetworkMemoryWorkflow,
} from "../src/stores/setup-workflows.js";
import { affectedQueries } from "../src/stores/sync-dependencies.js";

const t = ((key: string) => key) as never;

function query(key: string) {
	return [key] as const;
}

describe("cache dependency routing", () => {
	it("keeps audit subscribed and maps tables and event domains narrowly", () => {
		expect(affectedQueries([])(query("audit"))).toBe(true);
		expect(affectedQueries([])(query("conversation"))).toBe(false);

		const conversations = affectedQueries(["conversations"]);
		expect(conversations(query("conversations"))).toBe(true);
		expect(conversations(query("conversation"))).toBe(true);
		expect(conversations(query("snapshot"))).toBe(true);
		expect(conversations(query("memory"))).toBe(false);

		const events = affectedQueries(["event:conversation.updated", "event:run.completed"]);
		expect(events(query("conversation"))).toBe(true);
		expect(events(query("conversations"))).toBe(true);
		expect(events(query("runs"))).toBe(true);
		expect(events(query("permissions"))).toBe(true);
		expect(events(query("snapshot"))).toBe(true);
		expect(events(query("settings"))).toBe(false);
	});

	it("handles special login and embedding events without invalidating unrelated data", () => {
		const embedding = affectedQueries(["event:memory.embedding_download_changed"]);
		expect(embedding(query("embedding"))).toBe(true);
		expect(embedding(query("memory"))).toBe(false);

		const login = affectedQueries(["event:provider.login_changed"]);
		expect(login(query("providerLogin"))).toBe(true);
		expect(login(query("providers"))).toBe(false);
	});

	it("fails safe by invalidating every query for unknown sources", () => {
		expect(affectedQueries(["future_table"])(query("anything"))).toBe(true);
		expect(affectedQueries(["event:future.changed"])(query("anything"))).toBe(true);
	});
});

describe("store IPC helpers", () => {
	it("accepts only non-null records and string payload fields", () => {
		expect(isRecord({ value: "ok" })).toBe(true);
		expect(isRecord([])).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("value")).toBe(false);
		expect(payloadString({ value: "ok" }, "value")).toBe("ok");
		expect(payloadString({ value: 42 }, "value")).toBeUndefined();
		expect(payloadString(null, "value")).toBeUndefined();
	});

	it("unwraps success, converts RPC failures, and preserves transport failures", async () => {
		const client = {} as never;
		await expect(
			invoke(client, async () => ({ ok: true as const, data: { value: "safe" } })),
		).resolves.toEqual({ value: "safe" });
		await expect(
			invoke(client, async () => ({
				ok: false as const,
				error: { kind: "conflict", reason: "already_saved" },
			})),
		).rejects.toBeInstanceOf(IpcInvocationError);
		const transport = new Error("transport down");
		await expect(invoke(client, async () => Promise.reject(transport))).rejects.toBe(transport);
	});
});

describe("settings workflows", () => {
	it("selects conversation and vision routes and exposes successful feedback", async () => {
		const models = [
			{
				providerId: "relay",
				modelId: "reply",
				label: "Reply",
				supportsImages: false,
				createdAt: "2026-01-01",
			},
			{
				providerId: "relay",
				modelId: "vision",
				label: "Vision",
				supportsImages: true,
				createdAt: "2026-01-02",
			},
		];
		const select = vi.fn(async () => undefined);
		const setMultimodalFallback = vi.fn(async () => undefined);
		const setVisionAuto = vi.fn(async () => undefined);
		const store = {
			activeConversationId: "conversation-1",
			model: {
				data: () => ({
					models,
					selected: { providerId: "relay", modelId: "reply" },
					defaults: {
						vision: {
							mode: "manual",
							route: { providerId: "relay", modelId: "vision" },
						},
					},
				}),
				models: () => [],
				select,
				setMultimodalFallback,
				setVisionAuto,
			},
		} as unknown as CompanionStore;

		await new Promise<void>((resolve, reject) => {
			createRoot((dispose) => {
				const workflow = createConversationModelSettingsWorkflow(store, t);
				expect(workflow.configured()).toEqual(models);
				expect(workflow.selectedCurrentReplyOption()).toBe("relay\0reply");
				expect(workflow.selectedVisionOption()).toBe("relay\0vision");
				expect(workflow.visionOptions()).toEqual(["reply", "relay\0vision"]);
				expect(workflow.modelByOptionId("relay\0missing")).toBeUndefined();
				void (async () => {
					await workflow.selectCurrentReply("relay\0reply");
					expect(select).toHaveBeenCalledWith("conversation-1", "relay", "reply");
					expect(workflow.feedback()).toBe("settings.modelSaved");
					await workflow.setVisionModel("relay\0vision");
					expect(setMultimodalFallback).toHaveBeenCalledWith("relay", "vision");
					await workflow.setVisionModel("reply");
					expect(setVisionAuto).toHaveBeenCalled();
					dispose();
					resolve();
				})().catch(reject);
			});
		});
	});

	it("uses model fallbacks, ignores invalid selection, and reports structured failures", async () => {
		const fallback = {
			providerId: "fallback",
			modelId: "one",
			label: "Fallback",
			supportsImages: true,
			createdAt: "2026-01-01",
		};
		const failure = Object.assign(new Error("save failed"), { reason: "host rejected it" });
		const store = {
			activeConversationId: null,
			model: {
				data: () => ({ models: [], defaults: { vision: { mode: "auto" } } }),
				models: () => [fallback],
				select: vi.fn(),
				setMultimodalFallback: vi.fn(async () => Promise.reject(failure)),
				setVisionAuto: vi.fn(async () => Promise.reject("plain failure")),
			},
		} as unknown as CompanionStore;

		await new Promise<void>((resolve, reject) => {
			createRoot((dispose) => {
				const workflow = createConversationModelSettingsWorkflow(store, t);
				expect(workflow.configured()).toEqual([fallback]);
				expect(workflow.selectedCurrentReplyOption()).toBeNull();
				expect(workflow.selectedVisionOption()).toBe("reply");
				void (async () => {
					await workflow.selectCurrentReply(null);
					await workflow.selectCurrentReply("fallback\0one");
					expect(store.model.select).not.toHaveBeenCalled();
					await workflow.setVisionModel("fallback\0one");
					expect(workflow.error()).toBe("save failed (host rejected it)");
					await workflow.setVisionModel(null);
					expect(workflow.error()).toBe("plain failure");
					dispose();
					resolve();
				})().catch(reject);
			});
		});
	});

	it("stays safe when optional model projections are not installed yet", async () => {
		const setVisionAuto = vi.fn(async () => Promise.reject({ message: "bad shape", reason: 42 }));
		const store = {
			activeConversationId: "conversation-1",
			model: { setVisionAuto },
			onboarding: { status: "inactive", currentStepId: null },
			loading: false,
			character: undefined,
			embedding: undefined,
			error: null,
		} as unknown as CompanionStore;

		await new Promise<void>((resolve, reject) => {
			createRoot((dispose) => {
				const conversation = createConversationModelSettingsWorkflow(store, t);
				expect(conversation.configured()).toEqual([]);
				expect(conversation.selectedCurrentReplyOption()).toBeNull();
				expect(conversation.selectedVisionOption()).toBe("reply");
				expect(conversation.modelByOptionId("missing")).toBeUndefined();

				const firstMeeting = createFirstMeetingWorkflow(store);
				expect(firstMeeting.configuredModels()).toEqual([]);
				expect(firstMeeting.selectedReplyModel()).toBeNull();
				expect(firstMeeting.selectedVisionModel()).toBeNull();
				expect(firstMeeting.modelError()).toBeNull();
				expect(firstMeeting.currentStep()).toBeUndefined();
				expect(firstMeeting.currentStepIndex()).toBe(-1);
				expect(firstMeeting.currentStepLabel()).toBe("");
				expect(firstMeeting.visible()).toBe(false);

				void conversation.setVisionModel(null).then(() => {
					try {
						expect(conversation.error()).toBe("[object Object]");
						dispose();
						resolve();
					} catch (cause) {
						reject(cause);
					}
				});
			});
		});
	});

	it("builds proxy patches, trims manual URLs, and remains retryable after failure", async () => {
		const [settings, setSettings] = createSignal<SettingsData>({
			networkProxy: { mode: "system" },
			memory: { embeddingMode: "local" },
		} as SettingsData);
		const set = vi
			.fn()
			.mockRejectedValueOnce(new Error("cannot save"))
			.mockResolvedValueOnce(undefined);
		const store = { settings: { data: settings, set } } as unknown as CompanionStore;

		await new Promise<void>((resolve, reject) => {
			createRoot((dispose) => {
				const workflow = createNetworkMemoryWorkflow(store, t);
				expect(workflow.proxyMode()).toBe("system");
				expect(workflow.proxyUrl()).toBe("");
				workflow.setProxyMode("manual");
				workflow.setProxyUrl("  http://127.0.0.1:7890  ");
				void (async () => {
					await Promise.resolve();
					await workflow.save();
					expect(set).toHaveBeenLastCalledWith({
						networkProxy: { mode: "manual", url: "http://127.0.0.1:7890" },
					});
					expect(workflow.error()).toBe("cannot save");
					await workflow.save();
					expect(workflow.feedback()).toBe("settings.saved");
					workflow.setProxyUrl("   ");
					await workflow.save();
					expect(set).toHaveBeenLastCalledWith({ networkProxy: { mode: "manual" } });
					setSettings({ ...settings(), networkProxy: { mode: "off" } });
					dispose();
					resolve();
				})().catch(reject);
			});
		});
	});

	it("does nothing when proxy state is unavailable", async () => {
		const set = vi.fn();
		const store = { settings: { data: () => undefined, set } } as unknown as CompanionStore;
		await new Promise<void>((resolve) => {
			createRoot((dispose) => {
				const workflow = createNetworkMemoryWorkflow(store, t);
				expect(workflow.proxyMode()).toBeUndefined();
				void workflow.save().then(() => {
					expect(set).not.toHaveBeenCalled();
					dispose();
					resolve();
				});
			});
		});
	});
});
