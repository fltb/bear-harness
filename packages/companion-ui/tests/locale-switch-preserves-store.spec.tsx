import { I18nextProvider, i18n } from "@bear-harness/i18n";
import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createCompanionStore } from "../src/stores/companion.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

const COMPLETE_ONBOARDING = {
	status: "complete" as const,
	eventSeq: 0,
	stateData: { schema_version: 1 as const, flow_version: 1, answers: {}, decisions: {} },
};

/**
 * Loaded conversation with one persisted assistant message; the thread must
 * keep this message across a locale switch (which re-runs `CompanionRuntime`
 * and used to rebuild the whole store).
 */
function loadedClient() {
	const fixture = createTestClient();
	fixture.client.snapshot.get = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				eventSeq: 0,
				onboarding: COMPLETE_ONBOARDING,
				model: {
					pool: { models: [] },
					defaults: { vision: { mode: "auto" } },
					route: null,
				},
				conversation: {
					activeConversationId: "conversation-1",
					conversations: [
						{
							id: "conversation-1",
							title: "Locale switch",
							sceneTitle: "Scene",
							unread: false,
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					],
					messages: [
						{
							id: "assistant-1",
							role: "assistant" as const,
							adoptedVersionId: "assistant-1-v1",
							createdAt: "2026-01-01T00:00:01.000Z",
							versions: [
								{
									id: "assistant-1-v1",
									role: "assistant" as const,
									content: "必须保留的记忆测试消息",
									editedByUser: false,
									createdAt: "2026-01-01T00:00:01.000Z",
									adopted: true,
								},
							],
						},
					],
				},
			},
		}),
	);
	return fixture.client;
}

afterEach(() => {
	void i18n.changeLanguage("zh-CN");
});

describe("locale switching stability", () => {
	it("keeps the conversation projection when the language changes", async () => {
		const client = loadedClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const thread = await screen.findByRole("region", { name: zhCN.messages.conversation });
		await within(thread).findByText("必须保留的记忆测试消息");

		// Switch to English: CompanionRuntime re-runs on the language signal.
		await i18n.changeLanguage("en");

		// English copy proves the language actually switched and re-rendered…
		await screen.findByText("Active work");
		// …while the persisted message still renders: the store instance survived.
		expect(within(thread).getByText("必须保留的记忆测试消息")).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole("status", { name: "Loading" })).toBeNull());
	});

	it("is keyed by client: same client is stable, different clients are isolated", async () => {
		const clientA = createTestClient().client;
		const clientB = createTestClient().client;

		let first: ReturnType<typeof createCompanionStore> | undefined;
		let second: ReturnType<typeof createCompanionStore> | undefined;
		const capture = (fn: () => void) => {
			const Probe = () => {
				fn();
				return <div />;
			};
			render(() => (
				<I18nextProvider i18n={i18n}>
					<QueryClientProvider client={new QueryClient()}>
						<Probe />
					</QueryClientProvider>
				</I18nextProvider>
			));
		};

		capture(() => {
			first = createCompanionStore(clientA);
		});
		capture(() => {
			second = createCompanionStore(clientA);
		});
		expect(second).toBe(first);

		let other: ReturnType<typeof createCompanionStore> | undefined;
		capture(() => {
			other = createCompanionStore(clientB);
		});
		expect(other).not.toBe(first);
	});
});
