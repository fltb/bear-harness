import type { CompanionClient } from "@bear-harness/companion-client";

import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

const COMPLETE_ONBOARDING = {
	status: "complete" as const,
	eventSeq: 0,
	stateData: { schema_version: 1 as const, flow_version: 1, answers: {}, decisions: {} },
};

const TEST_MODEL = {
	providerId: "relay",
	providerName: "Relay Service",
	modelId: "fast",
	label: "Fast",
	supportsImages: true,
	createdAt: "2026-01-01",
};

function mirrorSnapshotActiveGet(client: CompanionClient): void {
	client.conversation.activeGet = vi.fn(async () => {
		const snapshot = await client.snapshot.get();
		if (!snapshot.ok) return snapshot;
		const conversation = snapshot.data.conversation;
		const activeConversationId = conversation?.activeConversationId;
		if (activeConversationId === undefined) return { ok: true as const, data: {} };
		return {
			ok: true as const,
			data: {
				conversation: {
					activeConversationId,
					...(conversation.activeBranchId === undefined
						? {}
						: { activeBranchId: conversation.activeBranchId }),
					id: conversation.id ?? activeConversationId,
					title: conversation.title ?? "",
					sceneTitle: conversation.sceneTitle ?? "",
					piTimeline: conversation.piTimeline ?? { entries: [] },
				},
			},
		};
	});
}

function activeComposerClient() {
	const { client } = createTestClient();
	client.snapshot.get = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				eventSeq: 0,
				onboarding: COMPLETE_ONBOARDING,
				model: {
					pool: { models: [TEST_MODEL] },
					defaults: { vision: { mode: "auto" } },
				},
				conversation: {
					activeConversationId: "conversation-1",
					conversations: [
						{
							id: "conversation-1",
							title: "New conversation",
							sceneTitle: "",
							unread: false,
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					],
					piTimeline: { entries: [] },
				},
			},
		}),
	);
	mirrorSnapshotActiveGet(client);
	client.model.poolGet = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { models: [TEST_MODEL] } }),
	);
	client.model.routeGet = vi.fn(({ conversationId }) =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversationId,
				selected: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
			},
		}),
	);
	client.onboarding.get = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
	);
	return client;
}

function neverSettle(): Promise<never> {
	const { promise } = Promise.withResolvers<never>();
	return promise;
}

/** A client whose Pi session switches to streaming on demand. */
function streamingComposerClient() {
	const client = activeComposerClient();
	client.message.send = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: { accepted: true as const, sessionId: "session-1" },
		}),
	);
	let projection = {
		activeConversationId: "conversation-1",
		id: "conversation-1",
		title: "New conversation",
		sceneTitle: "",
		piTimeline: { entries: [] },
		piSessionId: "session-1",
		piLiveState: { isStreaming: false },
	};
	client.conversation.activeGet = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { conversation: projection } }),
	);
	const streamGate = Promise.withResolvers<{
		ok: true;
		data: { events: unknown[] };
	}>();
	let subscription = 0;
	client.events.subscribe = vi.fn(() => {
		subscription += 1;
		if (subscription === 1) return streamGate.promise;
		return neverSettle();
	});
	return {
		client,
		startStreaming() {
			projection = {
				...projection,
				piLiveState: {
					isStreaming: true,
					streamingMessage: { text: "正在写", stopReason: "pending" as const },
				},
			};
			streamGate.resolve({
				ok: true,
				data: {
					events: [
						{
							seq: 1,
							kind: "pi.session.changed" as const,
							payload: {
								conversationId: "conversation-1",
								sessionId: "session-1",
								reason: "message" as const,
							},
						},
					],
				},
			});
		},
	};
}

describe("composer abort control", () => {
	it("shows a Stop button only while the Pi session streams and aborts the turn", async () => {
		const user = userEvent.setup();
		const { client, startStreaming } = streamingComposerClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const input = await screen.findByRole("textbox", { name: zhCN.composer.messageInputLabel });
		await waitFor(() => expect(input).toBeEnabled());
		// No Stop while the Pi session is idle.
		expect(screen.queryByRole("button", { name: zhCN.composer.stopLabel })).not.toBeInTheDocument();

		await user.type(input, "给我讲个故事");
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		// Preflight accepted; the Pi session starts streaming and publishes the
		// change. The Stop button appears only from piLiveState.isStreaming.
		startStreaming();
		const stop = await screen.findByRole("button", { name: zhCN.composer.stopLabel });
		await user.click(stop);
		await waitFor(() =>
			expect(client.message.abort).toHaveBeenCalledWith({ conversationId: "conversation-1" }),
		);
	});

	it("keeps the Stop button while the Pi live partial assistant is visible", async () => {
		const user = userEvent.setup();
		const { client, startStreaming } = streamingComposerClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const input = await screen.findByRole("textbox", { name: zhCN.composer.messageInputLabel });
		await waitFor(() => expect(input).toBeEnabled());
		await user.type(input, "继续说");
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		startStreaming();
		expect(await screen.findByRole("button", { name: zhCN.composer.stopLabel })).toBeVisible();
		expect(screen.queryByRole("button", { name: zhCN.composer.sendLabel })).not.toBeInTheDocument();
		expect(screen.getByText("正在写")).toBeInTheDocument();
	});
});
