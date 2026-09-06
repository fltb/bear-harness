import type { CompanionClient } from "@bear-harness/companion-client";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { type CompanionStore, createCompanionStore } from "../src/stores/companion.js";
import type { OnboardingData } from "../src/stores/ipc.js";
import { createOnboardingStore, type OnboardingStore } from "../src/stores/onboarding.js";
import { createTestClient, THEMED_CHARACTER } from "./fixtures.js";

function onboarding(currentStepId: string): OnboardingData {
	return {
		status: "active",
		currentStepId,
		stateData: { answers: {}, decisions: {} },
	};
}

function createStoreWithCleanup(client: CompanionClient) {
	let dispose: () => void = () => undefined;
	let store: CompanionStore | undefined;
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
		let current = doorClosed;
		client.onboarding.get = vi.fn(() => Promise.resolve({ ok: true as const, data: current }));
		client.onboarding.submit = vi.fn(() => {
			current = introduced;
			return Promise.resolve({ ok: true as const, data: current });
		});
		let dispose = () => undefined;
		let store: OnboardingStore | undefined;
		createRoot((cleanup) => {
			dispose = cleanup;
			store = createOnboardingStore(client);
		});
		if (!store) throw new Error("onboarding store was not created");

		try {
			await store.resync();
			await store.submit("door_closed");
			expect(store.data()).toEqual(introduced);
		} finally {
			dispose();
		}
	});

	it("resynchronizes the character onboarding query from Host", async () => {
		const { client } = createTestClient();
		const initial = onboarding("door_closed");
		const reset = onboarding("reset_step");
		let current = initial;
		client.onboarding.get = vi.fn(() => Promise.resolve({ ok: true as const, data: current }));
		let dispose = () => undefined;
		let store: OnboardingStore | undefined;
		createRoot((cleanup) => {
			dispose = cleanup;
			store = createOnboardingStore(client);
		});
		if (!store) throw new Error("onboarding store was not created");

		try {
			await store.resync();
			expect(store.data().currentStepId).toBe("door_closed");
			current = reset;
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
		let characterName = THEMED_CHARACTER.name;
		const snapshotGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					onboarding: doorClosed,
					character: { ...THEMED_CHARACTER, name: characterName },
				},
			}),
		);
		client.snapshot.get = snapshotGet;
		let current = doorClosed;
		client.onboarding.get = vi.fn(() => Promise.resolve({ ok: true as const, data: current }));
		client.onboarding.submit = vi.fn(() => {
			current = introduced;
			return Promise.resolve({ ok: true as const, data: current });
		});
		const { store, dispose } = createStoreWithCleanup(client);

		try {
			await waitFor(() => expect(store.onboarding.currentStepId).toBe("door_closed"));

			await store.submitOnboarding("door_closed");
			expect(store.onboarding.currentStepId).toBe("introduced");

			characterName = "Updated Host character";
			await store.refresh();
			await waitFor(() => expect(store.character?.name).toBe(characterName));
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
			Promise.resolve({
				ok: true as const,
				data: { character: THEMED_CHARACTER, onboarding: doorClosed },
			}),
		);
		let current = doorClosed;
		client.onboarding.get = vi.fn(() => Promise.resolve({ ok: true as const, data: current }));
		client.onboarding.submit = vi.fn(() => {
			current = introduced;
			return Promise.resolve({
				ok: false as const,
				error: { kind: "conflict", reason: "stale_onboarding_step" },
			});
		});
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
});
