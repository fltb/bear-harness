import type { CompanionClient } from "@bear-harness/companion-client";
import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConfiguredModel } from "../src/index.js";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const COMPLETE_ONBOARDING = {
	status: "complete" as const,
	stateData: { answers: {}, decisions: {} },
};

const TEST_MODEL = {
	providerId: "relay",
	providerName: "Relay Service",
	modelId: "fast",
	label: "Fast",
	supportsImages: true,
	createdAt: "2026-01-01",
};

const VISION_MODEL = {
	providerId: "vision-relay",
	providerName: "Vision Relay",
	modelId: "vision",
	label: "Vision Model",
	supportsImages: true,
	createdAt: "2026-01-02",
};

const acceptedUserEntry = (text: string) => ({
	type: "message" as const,
	id: crypto.randomUUID(),
	parentId: null,
	timestamp: new Date().toISOString(),
	message: { role: "user" as const, content: text, timestamp: Date.now() },
});

function configureActiveConversation(client: CompanionClient): void {
	client.conversation.list = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversations: [
					{
						conversationId: "conversation-1",
						name: "Test conversation",
						created: "2026-01-01T00:00:00.000Z",
						modified: "2026-01-01T00:00:00.000Z",
						messageCount: 0,
						firstMessage: "",
						isStreaming: false,
					},
				],
			},
		}),
	);
	client.conversation.open = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversationId: "conversation-1",
				name: "Test conversation",
				branch: { entries: [], hasMoreBefore: false },
				live: { isStreaming: false, steering: [], followUp: [] },
			},
		}),
	);
}

function renderComposerWithModels(
	client: ReturnType<typeof createTestClient>["client"],
	modelState: {
		pool: { models: ConfiguredModel[] };
		defaults: {
			vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } };
		};
		route: { conversationId: string; selected: { providerId: string; modelId: string } };
	},
): void {
	client.snapshot.get = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				onboarding: COMPLETE_ONBOARDING,
				character: THEMED_CHARACTER,
			},
		}),
	);
	configureActiveConversation(client);
	client.model.poolGet = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { models: modelState.pool.models } }),
	);
	// Keep the global FirstMeeting gate closed while these tests exercise the
	// composer in isolation. Without a reply default that modal mounts after
	// the composer, Kobalte correctly sets body pointer-events to none and
	// makes the routing controls appear present but not user-operable.
	client.model.defaultsGet = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				...modelState.defaults,
				reply: modelState.route.selected,
				onboardingComplete: true,
			},
		}),
	);
	client.model.routeGet = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: modelState.route }),
	);
	client.onboarding.get = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
	);
	render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
}

function configureSelectedModel(client: ReturnType<typeof createTestClient>["client"]): void {
	client.model.poolGet = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: { models: [TEST_MODEL] },
		}),
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
}

describe("composer", () => {
	it("inserts desktop file paths into ordinary user text", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedModel(client);
		const pickFiles = vi.fn(() => Promise.resolve(["/tmp/brief.pdf", "/tmp/data.xlsx"]));
		(globalThis as typeof globalThis & { bearDesktop?: unknown }).bearDesktop = {
			localFiles: { pickFiles, pickFolder: vi.fn(), pathsForDroppedFiles: vi.fn() },
		};
		try {
			renderComposerWithModels(client, {
				pool: { models: [TEST_MODEL] },
				defaults: { vision: { mode: "auto" } },
				route: {
					conversationId: "conversation-1",
					selected: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
				},
			});
			await user.click(await screen.findByRole("button", { name: zhCN.composer.attachLabel }));
			await user.click(screen.getByRole("menuitem", { name: zhCN.composer.uploadFile }));
			expect(pickFiles).toHaveBeenCalledOnce();
			await waitFor(() =>
				expect(screen.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toHaveValue(
					`本机文件："/tmp/brief.pdf"\n本机文件："/tmp/data.xlsx"`,
				),
			);
		} finally {
			delete (globalThis as typeof globalThis & { bearDesktop?: unknown }).bearDesktop;
		}
	});

	it("keeps a new conversation empty until the user explicitly chooses a model", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					onboarding: COMPLETE_ONBOARDING,
					character: THEMED_CHARACTER,
				},
			}),
		);
		configureActiveConversation(client);
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { models: [TEST_MODEL] } }),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const selector = await screen.findByRole("button", {
			name: new RegExp(zhCN.composer.modelLabel),
		});
		await waitFor(() => expect(selector).toBeEnabled());
		expect(selector).toHaveTextContent(zhCN.composer.chooseModel);
		expect(screen.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeDisabled();
	});

	it("switches the active conversation model from the composer", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					onboarding: COMPLETE_ONBOARDING,
					character: THEMED_CHARACTER,
				},
			}),
		);
		configureActiveConversation(client);
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					models: [
						{
							providerId: "relay",
							providerName: "Relay Service",
							modelId: "fast",
							label: "Fast",
							supportsImages: false,
							createdAt: "2026-01-01",
						},
						{
							providerId: "relay",
							providerName: "Relay Service",
							modelId: "deep",
							label: "Deep",
							supportsImages: true,
							createdAt: "2026-01-02",
						},
					],
				},
			}),
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
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const selector = await screen.findByRole("button", {
			name: new RegExp(zhCN.composer.modelLabel),
		});
		await waitFor(() => expect(selector).toBeEnabled());
		await selectKobalteOption(userEvent.setup(), selector, { label: "Deep (Relay Service)" });
		await waitFor(() =>
			expect(client.model.routeSet).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				selected: { providerId: "relay", modelId: "deep" },
			}),
		);
		expect(client.model.defaultsSetReply).not.toHaveBeenCalled();
	});

	it("submits trimmed text to the active conversation and clears only after dispatch", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedModel(client);
		const messageSend = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { entry: acceptedUserEntry("测试消息") } }),
		);
		client.message.send = messageSend;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					onboarding: COMPLETE_ONBOARDING,
					character: THEMED_CHARACTER,
				},
			}),
		);
		configureActiveConversation(client);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const composer = await screen.findByRole("textbox", {
			name: zhCN.composer.messageInputLabel,
		});
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "  测试消息  ");
		await user.keyboard("{Enter}");

		await waitFor(() =>
			expect(messageSend).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conversation-1",
					text: "测试消息",
				}),
			),
		);
		expect(composer).toHaveValue("");
	});

	it("keeps Shift+Enter as a newline instead of dispatching", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedModel(client);
		const messageSend = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { entry: acceptedUserEntry("unused") } }),
		);
		client.message.send = messageSend;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					onboarding: COMPLETE_ONBOARDING,
					character: THEMED_CHARACTER,
				},
			}),
		);
		configureActiveConversation(client);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const composer = await screen.findByRole("textbox", {
			name: zhCN.composer.messageInputLabel,
		});
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "第一行");
		await user.keyboard("{Shift>}{Enter}{/Shift}第二行");

		expect(messageSend).not.toHaveBeenCalled();
		expect(composer).toHaveValue("第一行\n第二行");
	});

	it("shows one local alert when selecting a model fails", async () => {
		const { client } = createTestClient();
		client.model.routeSet = vi.fn(() => Promise.reject(new Error("model unavailable")));
		renderComposerWithModels(client, {
			pool: { models: [TEST_MODEL, VISION_MODEL] },
			defaults: { vision: { mode: "auto" } },
			route: {
				conversationId: "conversation-1",
				selected: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
			},
		});

		const selector = await screen.findByRole("button", {
			name: new RegExp(zhCN.composer.modelLabel),
		});
		await waitFor(() => expect(selector).toBeEnabled());
		await selectKobalteOption(userEvent.setup(), selector, {
			label: "Vision Model (Vision Relay)",
		});

		const alerts = await screen.findAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toHaveTextContent("model unavailable");
	});

	it("keeps a failed pending message and allows an explicit retry", async () => {
		const { client } = createTestClient();
		const messageSend = vi
			.fn()
			.mockRejectedValueOnce(new Error("send unavailable"))
			.mockResolvedValueOnce({
				ok: true as const,
				data: { entry: acceptedUserEntry("稍后再试") },
			});
		client.message.send = messageSend;
		renderComposerWithModels(client, {
			pool: { models: [TEST_MODEL] },
			defaults: { vision: { mode: "auto" } },
			route: {
				conversationId: "conversation-1",
				selected: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
			},
		});

		const user = userEvent.setup();
		const composer = await screen.findByRole("textbox", {
			name: zhCN.composer.messageInputLabel,
		});
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "稍后再试");
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		await screen.findByText(zhCN.messages.sendFailed);
		expect(composer).toHaveValue("");
		const retry = screen.getByRole("button", { name: zhCN.messages.retry });
		expect(retry).toBeEnabled();
		await user.click(retry);
		await waitFor(() => expect(messageSend).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(screen.queryByText(zhCN.messages.sendFailed)).not.toBeInTheDocument(),
		);
	});
});
