import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createCompanionStore } from "../src/stores/companion.js";
import type { OnboardingData } from "../src/stores/ipc.js";
import { createOnboardingStore } from "../src/stores/onboarding.js";
import { createTestClient } from "./fixtures.js";

function onboarding(currentStepId: string): OnboardingData {
	return {
		status: "active",
		currentStepId,
		stateData: { answers: {}, decisions: {} },
	};
}

function createStoreWithCleanup(client: ReturnType<typeof createTestClient>["client"]) {
	let dispose: () => void = () => undefined;
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
	if (!store) throw new Error("store was not created inside QueryClientProvider");
	return { store, dispose };
}

describe("onboarding projection", () => {
	it("adopts a successful submit response", async () => {
		const { client } = createTestClient();
		const doorClosed = onboarding("door_closed");
		const introduced = onboarding("introduced");
		let onboardingGetCount = 0;
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: onboardingGetCount++ === 0 ? doorClosed : introduced,
			}),
		);
		client.onboarding.submit = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: introduced }),
		);
		let dispose = () => undefined;
		let store: ReturnType<typeof createOnboardingStore> | undefined;
		createRoot((cleanup) => {
			dispose = cleanup;
			store = createOnboardingStore(client);
		});
		if (!store) throw new Error("onboarding store was not created");

		try {
			store._hydrate(doorClosed);
			await store.submit("door_closed");
			expect(store.data()).toEqual(introduced);
		} finally {
			dispose();
		}
	});

	it("hydrates snapshots and resynchronizes from Host", async () => {
		const { client } = createTestClient();
		const initial = onboarding("door_closed");
		const reset = onboarding("reset_step");
		client.onboarding.get = vi.fn(() => Promise.resolve({ ok: true as const, data: reset }));
		let dispose = () => undefined;
		let store: ReturnType<typeof createOnboardingStore> | undefined;
		createRoot((cleanup) => {
			dispose = cleanup;
			store = createOnboardingStore(client);
		});
		if (!store) throw new Error("onboarding store was not created");

		try {
			store._hydrate(initial);
			store._hydrate(undefined);
			expect(store.data().currentStepId).toBe("door_closed");
			await store.resync();
			await waitFor(() => expect(store?.data().currentStepId).toBe("reset_step"));
		} finally {
			dispose();
		}
	});

	it("keeps an accepted transition when the boot snapshot refetches", async () => {
		const { client } = createTestClient();
		const doorClosed = onboarding("door_closed");
		const introduced = onboarding("introduced");
		const snapshotGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { onboarding: doorClosed } }),
		);
		client.snapshot.get = snapshotGet;
		let onboardingGetCount = 0;
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: onboardingGetCount++ === 0 ? doorClosed : introduced,
			}),
		);
		client.onboarding.submit = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: introduced }),
		);
		const { store, dispose } = createStoreWithCleanup(client);

		try {
			await waitFor(() => expect(store.onboarding.currentStepId).toBe("door_closed"));

			await store.submitOnboarding("door_closed");
			expect(store.onboarding.currentStepId).toBe("introduced");

			await store.refresh();
			await waitFor(() => expect(snapshotGet).toHaveBeenCalledTimes(2));
			expect(store.onboarding.currentStepId).toBe("introduced");
		} finally {
			dispose();
		}
	});

	it("resynchronizes from the Host after another renderer advances the current step", async () => {
		const { client } = createTestClient();
		const doorClosed = onboarding("door_closed");
		const introduced = onboarding("introduced");
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { onboarding: doorClosed } }),
		);
		let getCount = 0;
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: getCount++ === 0 ? doorClosed : introduced }),
		);
		client.onboarding.submit = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "conflict", reason: "stale_onboarding_step" },
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);

		try {
			await waitFor(() => expect(store.onboarding.currentStepId).toBe("door_closed"));

			await store.submitOnboarding("door_closed");

			await waitFor(() => expect(store.onboarding.currentStepId).toBe("introduced"));
			expect(store.error).toBeNull();
		} finally {
			dispose();
		}
	});

	it("projects the canonical conversation created by onboarding completion", async () => {
		const { client } = createTestClient();
		const initial = onboarding("memory_choice");
		const complete: OnboardingData = {
			status: "complete",
			stateData: { answers: {}, decisions: {} },
		};
		const conversation = {
			conversationId: "onboarding-conversation",
			name: "First meeting",
			branch: { entries: [], hasMoreBefore: false },
			live: { isStreaming: false, pendingToolCallIds: [], steering: [], followUp: [] },
		};
		let completed = false;
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: completed ? complete : initial }),
		);
		client.onboarding.submit = vi.fn(() => {
			completed = true;
			return Promise.resolve({ ok: true as const, data: complete });
		});
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversations: completed
						? [
								{
									conversationId: conversation.conversationId,
									name: conversation.name,
									created: "2026-08-22T00:00:00.000Z",
									modified: "2026-08-22T00:00:00.000Z",
									messageCount: 0,
									firstMessage: "",
									isStreaming: false,
								},
							]
						: [],
				},
			}),
		);
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: conversation }),
		);
		const { store, dispose } = createStoreWithCleanup(client);

		try {
			await waitFor(() => expect(store.onboarding.currentStepId).toBe("memory_choice"));
			await store.submitOnboarding("memory_choice", "disabled");
			expect(store.onboarding.status).toBe("complete");
			expect(store.activeConversationId).toBe(conversation.conversationId);
			expect(store.conversations).toEqual([
				expect.objectContaining({
					conversationId: conversation.conversationId,
					name: conversation.name,
				}),
			]);
		} finally {
			dispose();
		}
	});
});
