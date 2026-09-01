import { I18nextProvider, i18n } from "@bear-harness/i18n";
import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createCompanionStore } from "../src/stores/companion.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";

const COMPLETE_ONBOARDING = {
	status: "complete" as const,
	stateData: { answers: {}, decisions: {} },
};

/**
 * Loaded conversation with one persisted assistant message; the thread must
 * keep this message across a locale switch (which re-runs `CompanionRuntime`
 * and used to rebuild the whole store).
 */
function loadedClient() {
	const fixture = createTestClient();
	const activeProjection = {
		conversationId: "conversation-1",
		name: "Locale switch",
		branch: {
			entries: [
				{
					type: "message" as const,
					id: "assistant-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: "必须保留的记忆测试消息" }],
						provider: "test",
						model: "test",
						timestamp: 1,
						stopReason: "stop" as const,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				},
			],
			hasMoreBefore: false,
		},
		live: { isStreaming: false, steering: [], followUp: [] },
	};
	fixture.client.snapshot.get = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				onboarding: COMPLETE_ONBOARDING,
				character: THEMED_CHARACTER,
			},
		}),
	);
	fixture.client.conversation.list = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversations: [
					{
						conversationId: activeProjection.conversationId,
						name: activeProjection.name,
						created: "2026-01-01T00:00:00.000Z",
						modified: "2026-01-01T00:00:01.000Z",
						messageCount: 1,
						firstMessage: "",
						isStreaming: false,
					},
				],
			},
		}),
	);
	fixture.client.conversation.open = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: activeProjection }),
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
