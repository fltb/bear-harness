import type { CompanionClient } from "@bear-harness/companion-client";
import { zhCN } from "@bear-harness/i18n/locales";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConfiguredModel } from "../src/index.js";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

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

const TEXT_MODEL = {
	providerId: "text-relay",
	providerName: "Text Relay",
	modelId: "text",
	label: "Text Model",
	supportsImages: false,
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

function configureActiveConversation(client: CompanionClient): void {
	client.conversation.activeGet = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversation: {
					activeConversationId: "conversation-1",
					id: "conversation-1",
					title: "Test conversation",
					sceneTitle: "",
					piTimeline: { entries: [] },
				},
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
				eventSeq: 0,
				onboarding: COMPLETE_ONBOARDING,
				conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
				model: modelState,
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
			data: { ...modelState.defaults, reply: modelState.route.selected },
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
	it("keeps a new conversation empty until the user explicitly chooses a model", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
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
					eventSeq: 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
					model: {
						pool: {
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
						defaults: { vision: { mode: "auto" } },
						route: {
							conversationId: "conversation-1",
							selected: { providerId: "relay", modelId: "fast" },
						},
					},
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
		expect(client.model.defaultsSetReply).toHaveBeenCalledWith({
			reply: { providerId: "relay", modelId: "deep" },
		});
	});

	it("uploads a file in chunks and sends only its attachment ID", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedModel(client);
		renderComposerWithModels(client, {
			pool: { models: [TEST_MODEL] },
			defaults: { vision: { mode: "auto" } },
			route: {
				conversationId: "conversation-1",
				selected: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
			},
		});

		await waitFor(() =>
			expect(screen.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled(),
		);
		const picker = screen.getByLabelText(zhCN.composer.uploadFile);
		fireEvent.change(picker, {
			target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
		});
		await waitFor(() =>
			expect(client.conversationAttachment.completeUpload).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				uploadId: "upload-1",
			}),
		);
		expect(client.conversationAttachment.appendChunk).toHaveBeenCalledWith({
			conversationId: "conversation-1",
			uploadId: "upload-1",
			fileIndex: 0,
			offset: 0,
			base64: "YWJj",
		});

		await user.type(
			screen.getByRole("textbox", { name: zhCN.composer.messageInputLabel }),
			"请阅读",
		);
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));
		await waitFor(() =>
			expect(client.message.send).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				text: "请阅读",
				attachmentIds: ["attachment-1"],
			}),
		);
	});
	it("uploads an image through attachment transport and sends only its attachment ID", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedModel(client);
		renderComposerWithModels(client, {
			pool: { models: [TEST_MODEL] },
			defaults: { vision: { mode: "auto" } },
			route: {
				conversationId: "conversation-1",
				selected: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
			},
		});
		await waitFor(() =>
			expect(screen.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled(),
		);

		fireEvent.change(screen.getByLabelText(zhCN.composer.uploadFile), {
			target: { files: [new File(["png-bytes"], "pixel.png", { type: "image/png" })] },
		});
		await waitFor(() =>
			expect(client.conversationAttachment.completeUpload).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				uploadId: "upload-1",
			}),
		);
		expect(client.conversationAttachment.startUpload).toHaveBeenCalledWith({
			conversationId: "conversation-1",
			kind: "file",
			name: "pixel.png",
			entries: [
				{
					entryKind: "file",
					relativePath: "pixel.png",
					mime: "image/png",
					bytes: 9,
				},
			],
		});

		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));
		await waitFor(() =>
			expect(client.message.send).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				text: "",
				attachmentIds: ["attachment-1"],
			}),
		);
		expect(client.message.send.mock.calls[0]?.[0]).not.toHaveProperty("attachments");
	});
	it("retries a failed image upload and discards the completed attachment", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		client.conversationAttachment.appendChunk = vi
			.fn()
			.mockRejectedValueOnce(new Error("upload failed"))
			.mockResolvedValue({ ok: true as const, data: null });
		configureSelectedModel(client);
		renderComposerWithModels(client, {
			pool: { models: [TEST_MODEL] },
			defaults: { vision: { mode: "auto" } },
			route: {
				conversationId: "conversation-1",
				selected: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
			},
		});
		await waitFor(() =>
			expect(screen.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled(),
		);

		fireEvent.change(screen.getByLabelText(zhCN.composer.uploadFile), {
			target: { files: [new File(["image"], "retry.png", { type: "image/png" })] },
		});
		await user.click(await screen.findByRole("button", { name: "Retry" }));
		await waitFor(() => expect(client.conversationAttachment.completeUpload).toHaveBeenCalled());
		expect(client.conversationAttachment.startUpload).toHaveBeenCalledTimes(2);

		await user.click(screen.getByRole("button", { name: "Remove note.txt" }));
		await waitFor(() =>
			expect(client.conversationAttachment.discard).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				attachmentId: "attachment-1",
			}),
		);
	});

	it("cancels an in-progress image upload when its draft is removed", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const pendingChunk: {
			resolve?: (value: { ok: true; data: null }) => void;
		} = {};
		client.conversationAttachment.appendChunk = vi.fn(
			() =>
				new Promise<{ ok: true; data: null }>((resolve) => {
					pendingChunk.resolve = resolve;
				}),
		);
		configureSelectedModel(client);
		renderComposerWithModels(client, {
			pool: { models: [TEST_MODEL] },
			defaults: { vision: { mode: "auto" } },
			route: {
				conversationId: "conversation-1",
				selected: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
			},
		});
		await waitFor(() =>
			expect(screen.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled(),
		);

		fireEvent.change(screen.getByLabelText(zhCN.composer.uploadFile), {
			target: { files: [new File(["image"], "cancel.png", { type: "image/png" })] },
		});
		await waitFor(() => expect(client.conversationAttachment.appendChunk).toHaveBeenCalled());
		await user.click(screen.getByRole("button", { name: "Remove cancel.png" }));
		await waitFor(() =>
			expect(client.conversationAttachment.cancelUpload).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				uploadId: "upload-1",
			}),
		);
		expect(screen.queryByText("cancel.png")).not.toBeInTheDocument();
		pendingChunk.resolve?.({ ok: true, data: null });
	});
	it("submits trimmed text to the active conversation and clears only after dispatch", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedModel(client);
		const messageSend = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { messageId: "m1" } }),
		);
		client.message.send = messageSend;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
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
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		await waitFor(() =>
			expect(messageSend).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				text: "测试消息",
			}),
		);
		expect(composer).toHaveValue("");
	});

	it("keeps Shift+Enter as a newline instead of dispatching", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedModel(client);
		const messageSend = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { messageId: "m1" } }),
		);
		client.message.send = messageSend;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
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

	it("keeps a failed message draft and allows an explicit resubmit", async () => {
		const { client } = createTestClient();
		const messageSend = vi
			.fn()
			.mockRejectedValueOnce(new Error("send unavailable"))
			.mockResolvedValueOnce({
				ok: true as const,
				data: { accepted: true as const, sessionId: "session-1", entryId: "entry-1" },
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

		const alerts = await screen.findAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toHaveTextContent("send unavailable");
		expect(composer).toHaveValue("稍后再试");
		const retry = screen.getByRole("button", { name: zhCN.composer.sendLabel });
		expect(retry).toBeEnabled();
		await user.click(retry);
		await waitFor(() => expect(messageSend).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(composer).toHaveValue(""));
		expect(screen.queryByText("send unavailable")).not.toBeInTheDocument();
	});
});
