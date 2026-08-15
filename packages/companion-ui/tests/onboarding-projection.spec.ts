import { waitFor } from "@testing-library/dom";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createCompanionStore } from "../src/stores/companion.js";
import type { OnboardingData } from "../src/stores/ipc.js";
import { createTestClient } from "./fixtures.js";

function onboarding(currentStepId: string, eventSeq: number): OnboardingData {
	return {
		status: "active",
		currentStepId,
		eventSeq,
		stateData: { schema_version: 1, flow_version: 1, answers: {}, decisions: {} },
	};
}

function createStoreWithCleanup(client: ReturnType<typeof createTestClient>["client"]) {
	let dispose: () => void = () => undefined;
	const store = createRoot((cleanup) => {
		dispose = cleanup;
		return createCompanionStore(client);
	});
	return { store, dispose };
}

describe("onboarding projection ordering", () => {
	it("keeps an accepted transition when an older snapshot arrives afterwards", async () => {
		const { client } = createTestClient();
		const doorClosed = onboarding("door_closed", 7);
		const introduced = onboarding("introduced", 8);
		const snapshotGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { eventSeq: 7, onboarding: doorClosed } }),
		);
		client.snapshot.get = snapshotGet;
		client.onboarding.get = vi.fn(() => Promise.resolve({ ok: true as const, data: doorClosed }));
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
});
