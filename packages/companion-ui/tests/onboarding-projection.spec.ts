import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createCompanionStore } from "../src/stores/companion.js";
import type { OnboardingData } from "../src/stores/ipc.js";
import { createOnboardingStore } from "../src/stores/onboarding.js";
import { createTestClient } from "./fixtures.js";

function onboarding(currentStepId: string, eventSeq: number): OnboardingData {
	return {
		status: "active",
		currentStepId,
		eventSeq,
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

describe("onboarding projection ordering", () => {
	it("adopts a successful submit response even after an unrelated higher snapshot sequence", async () => {
		const { client } = createTestClient();
		const doorClosed = onboarding("door_closed", 100);
		const introduced = onboarding("introduced", 8);
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

	it("ignores stale and unrelated events, projects state changes, and resets from Host", async () => {
		const { client } = createTestClient();
		const initial = onboarding("door_closed", 4);
		const reset = onboarding("reset_step", 7);
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
			store._hydrate(onboarding("stale", 3));
			expect(store.data().currentStepId).toBe("door_closed");

			store._applyEvent({ kind: "conversation.updated", seq: 5, payload: {} });
			expect(store.data().currentStepId).toBe("door_closed");
			store._applyEvent({
				kind: "onboarding.state_changed",
				seq: 6,
				payload: onboarding("introduced", 0),
			});
			expect(store.data().currentStepId).toBe("introduced");

			store._applyEvent({ kind: "onboarding.reset", seq: 7, payload: null });
			await waitFor(() => expect(store?.data().currentStepId).toBe("reset_step"));
		} finally {
			dispose();
		}
	});

	it("keeps an accepted transition when an older snapshot arrives afterwards", async () => {
		const { client } = createTestClient();
		const doorClosed = onboarding("door_closed", 7);
		const introduced = onboarding("introduced", 8);
		const snapshotGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { eventSeq: 7, onboarding: doorClosed } }),
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
			await waitFor(() => expect(snapshotGet).toHaveBeenCalledTimes(3));
			expect(store.onboarding.currentStepId).toBe("introduced");
			expect(store.onboarding.eventSeq).toBe(8);
		} finally {
			dispose();
		}
	});

	it("resynchronizes from the Host after another renderer advances the current step", async () => {
		const { client } = createTestClient();
		const doorClosed = onboarding("door_closed", 11);
		const introduced = onboarding("introduced", 12);
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { eventSeq: 11, onboarding: doorClosed } }),
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
			expect(store.onboarding.eventSeq).toBe(12);
			expect(store.error).toBeNull();
		} finally {
			dispose();
		}
	});

	it("projects the canonical conversation created by onboarding completion", async () => {
		const { client } = createTestClient();
		const initial = onboarding("memory_choice", 20);
		const complete: OnboardingData = {
			status: "complete",
			eventSeq: 21,
			stateData: { answers: {}, decisions: {} },
		};
		const conversation = {
			sessionId: "onboarding-conversation",
			name: "First meeting",
			timeline: { entries: [] },
			live: { isStreaming: false, queuedUserMessages: [] },
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
					sessions: completed
						? [
								{
									id: conversation.sessionId,
									title: conversation.name,
									created: "2026-08-22T00:00:00.000Z",
									modified: "2026-08-22T00:00:00.000Z",
									messageCount: 0,
									firstMessage: "",
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
			expect(store.activeConversationId).toBe(conversation.sessionId);
			expect(store.conversations).toEqual([
				expect.objectContaining({ id: conversation.sessionId, title: conversation.name }),
			]);
		} finally {
			dispose();
		}
	});
});
