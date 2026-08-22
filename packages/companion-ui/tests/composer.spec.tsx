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
	});

	it("keeps the selected text model and identifies the configured image reader", async () => {
		const { client } = createTestClient();
		const models = [
			{
				providerId: "text-relay",
				providerName: "Text Relay",
				modelId: "text",
				label: "Text Model",
				supportsImages: false,
				createdAt: "2026-01-01",
			},
			{
				providerId: "vision-relay",
				providerName: "Vision Relay",
				modelId: "vision",
				label: "Vision Model",
				supportsImages: true,
				createdAt: "2026-01-02",
			},
		];
		const modelState = {
			pool: { models },
			defaults: {
				vision: {
					mode: "manual" as const,
					route: { providerId: "vision-relay", modelId: "vision" },
				},
			},
			route: {
				conversationId: "conversation-1",
				selected: { providerId: "text-relay", modelId: "text" },
			},
		};
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
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: modelState.pool }),
		);
		client.model.defaultsGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: modelState.defaults }),
		);
		client.model.routeGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: modelState.route }),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const selector = await screen.findByRole("button", {
			name: new RegExp(zhCN.composer.modelLabel),
		});
		await waitFor(() => expect(selector).toHaveTextContent("Text Model (Text Relay)"));
		const picker = screen.getByLabelText(zhCN.composer.attachLabel, { selector: "input" });
		if (!(picker instanceof HTMLInputElement)) throw new Error("composer file picker missing");
		fireEvent.change(picker, {
			target: { files: [new File(["image"], "photo.png", { type: "image/png" })] },
		});

		expect(await screen.findByRole("status")).toHaveTextContent(
			"图片由 Vision Model (Vision Relay) 读取",
		);
		expect(selector).toHaveTextContent("Text Model (Text Relay)");
	});

	it("sends image attachments as native multimodal input", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedModel(client);
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
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const image = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
		await waitFor(() =>
			expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toBeEnabled(),
		);
		const picker = screen.getByLabelText(zhCN.composer.attachLabel, { selector: "input" });
		if (!(picker instanceof HTMLInputElement)) throw new Error("composer file picker missing");
		fireEvent.change(picker, { target: { files: [image] } });
		await waitFor(() =>
			expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toHaveTextContent(
				"1",
			),
		);
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));
		await waitFor(() =>
			expect(client.message.send).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				text: "[图片：photo.png]",
				attachments: [{ name: "photo.png", mime: "image/png", base64: "AQID" }],
			}),
		);
	});

	it("inlines text attachments into the message without creating image input", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configureSelectedModel(client);
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
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const note = new File(["原始内容"], "note.md", { type: "text/markdown" });
		Object.defineProperty(note, "text", { value: () => Promise.resolve("原始内容") });
		await waitFor(() =>
			expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toBeEnabled(),
		);
		const picker = screen.getByLabelText(zhCN.composer.attachLabel, { selector: "input" });
		if (!(picker instanceof HTMLInputElement)) throw new Error("composer file picker missing");
		fireEvent.change(picker, { target: { files: [note] } });
		await waitFor(() =>
			expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toHaveTextContent(
				"1",
			),
		);
		await user.type(
			screen.getByRole("textbox", { name: zhCN.composer.messageInputLabel }),
			"请阅读",
		);
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		await waitFor(() =>
			expect(client.message.send).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				text: "请阅读\n\n[材料：note.md]\n原始内容",
				attachments: undefined,
			}),
		);
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

	it("rejects a selection that exceeds the shared attachment contract", async () => {
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
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toBeEnabled(),
		);
		const picker = screen.getByLabelText(zhCN.composer.attachLabel, { selector: "input" });
		if (!(picker instanceof HTMLInputElement)) throw new Error("composer file picker missing");
		const files = Array.from({ length: 11 }, (_, index) => {
			const file = new File([`content-${index}`], `note-${index}.txt`, { type: "text/plain" });
			Object.defineProperty(file, "text", {
				value: () => Promise.resolve(`content-${index}`),
			});
			return file;
		});
		Object.defineProperty(files[1], "size", { value: 11 * 1024 * 1024 });
		fireEvent.change(picker, { target: { files } });

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"一次最多添加 10 个文件，每个文件不超过 10 MB",
		);
		const attachmentButton = screen.getByRole("button", { name: zhCN.composer.attachLabel });
		expect(attachmentButton).toBeEnabled();
		expect(attachmentButton).not.toHaveTextContent(/\d/);
		expect(screen.getByRole("button", { name: zhCN.composer.sendLabel })).toBeDisabled();
		expect(messageSend).not.toHaveBeenCalled();
	});

	it("reports a browser file-read failure without sending a message", async () => {
		const { client } = createTestClient();
		configureSelectedModel(client);
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
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toBeEnabled(),
		);
		const picker = screen.getByLabelText(zhCN.composer.attachLabel, { selector: "input" });
		if (!(picker instanceof HTMLInputElement)) throw new Error("composer file picker missing");
		const unreadable = new File(["content"], "locked.txt", { type: "text/plain" });
		Object.defineProperty(unreadable, "text", {
			value: () => Promise.reject(new Error("无法读取 locked.txt")),
		});
		fireEvent.change(picker, { target: { files: [unreadable] } });

		expect(await screen.findByRole("alert")).toHaveTextContent("无法读取 locked.txt");
		expect(client.message.send).not.toHaveBeenCalled();
	});

	it("blocks sending with a settings shortcut when no image reader is configured", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		renderComposerWithModels(client, {
			pool: { models: [TEXT_MODEL] },
			defaults: { vision: { mode: "auto" } },
			route: {
				conversationId: "conversation-1",
				selected: { providerId: TEXT_MODEL.providerId, modelId: TEXT_MODEL.modelId },
			},
		});

		const selector = await screen.findByRole("button", {
			name: new RegExp(zhCN.composer.modelLabel),
		});
		await waitFor(() => expect(selector).toHaveTextContent("Text Model (Text Relay)"));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toBeEnabled(),
		);
		const picker = screen.getByLabelText(zhCN.composer.attachLabel, { selector: "input" });
		if (!(picker instanceof HTMLInputElement)) throw new Error("composer file picker missing");
		fireEvent.change(picker, {
			target: {
				files: [new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })],
			},
		});

		expect(await screen.findByText(zhCN.composer.imageModelMissing)).toBeVisible();
		expect(
			screen.getByRole("button", { name: zhCN.composer.goToImageModelSettings }),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: zhCN.composer.removeImages })).toBeEnabled();
		expect(screen.getByRole("button", { name: zhCN.composer.sendLabel })).toBeDisabled();

		await user.click(screen.getByRole("button", { name: zhCN.composer.goToImageModelSettings }));
		const dialog = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
		await waitFor(() =>
			expect(
				within(dialog).getByRole("button", { name: new RegExp(zhCN.settings.visionModel) }),
			).toHaveFocus(),
		);
	});

	it("recovers by removing images when no image reader is configured", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		renderComposerWithModels(client, {
			pool: { models: [TEXT_MODEL] },
			defaults: { vision: { mode: "auto" } },
			route: {
				conversationId: "conversation-1",
				selected: { providerId: TEXT_MODEL.providerId, modelId: TEXT_MODEL.modelId },
			},
		});

		const composer = await screen.findByRole("textbox", {
			name: zhCN.composer.messageInputLabel,
		});
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "看图");
		const picker = screen.getByLabelText(zhCN.composer.attachLabel, { selector: "input" });
		if (!(picker instanceof HTMLInputElement)) throw new Error("composer file picker missing");
		fireEvent.change(picker, {
			target: {
				files: [new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() =>
			expect(screen.getByText(zhCN.composer.imageModelMissing)).toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: zhCN.composer.sendLabel })).toBeDisabled();

		await user.click(screen.getByRole("button", { name: zhCN.composer.removeImages }));
		expect(screen.queryByText(zhCN.composer.imageModelMissing)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).not.toHaveTextContent(
			/\d/,
		);
		expect(screen.getByRole("button", { name: zhCN.composer.sendLabel })).toBeEnabled();
		expect(composer).toHaveValue("看图");
	});

	it("keeps the draft and images when the image route rejects the request", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		let resolveRetry!: (result: { ok: true; data: { messageId: string } }) => void;
		const retryResult = new Promise<{ ok: true; data: { messageId: string } }>((resolve) => {
			resolveRetry = resolve;
		});
		const messageSend = vi
			.fn()
			.mockRejectedValueOnce(new Error("image route unavailable"))
			.mockReturnValueOnce(retryResult);
		client.message.send = messageSend;
		renderComposerWithModels(client, {
			pool: { models: [TEXT_MODEL, VISION_MODEL] },
			defaults: {
				vision: {
					mode: "manual",
					route: { providerId: VISION_MODEL.providerId, modelId: VISION_MODEL.modelId },
				},
			},
			route: {
				conversationId: "conversation-1",
				selected: { providerId: TEXT_MODEL.providerId, modelId: TEXT_MODEL.modelId },
			},
		});

		const composer = await screen.findByRole("textbox", {
			name: zhCN.composer.messageInputLabel,
		});
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "看图");
		const picker = screen.getByLabelText(zhCN.composer.attachLabel, { selector: "input" });
		if (!(picker instanceof HTMLInputElement)) throw new Error("composer file picker missing");
		fireEvent.change(picker, {
			target: {
				files: [new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				"图片由 Vision Model (Vision Relay) 读取",
			),
		);

		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		expect(messageSend).toHaveBeenCalledTimes(1);
		expect(messageSend).toHaveBeenLastCalledWith({
			conversationId: "conversation-1",
			text: "看图",
			attachments: [{ name: "photo.png", mime: "image/png", base64: "AQID" }],
		});
		expect(composer).toHaveValue("看图");
		expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toHaveTextContent("1");
		expect(screen.queryByRole("button", { name: zhCN.composer.sendLabel })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: zhCN.composer.imageRouteRetry })).toBeEnabled();
		expect(
			screen.getByRole("button", { name: zhCN.composer.goToImageModelSettings }),
		).toBeEnabled();

		await user.click(screen.getByRole("button", { name: zhCN.composer.imageRouteRetry }));
		expect(screen.getByText(zhCN.composer.imageRouteFailed)).toBeInTheDocument();
		expect(composer).toHaveValue("看图");
		expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toHaveTextContent("1");
		expect(messageSend).toHaveBeenLastCalledWith({
			conversationId: "conversation-1",
			text: "看图",
			attachments: [{ name: "photo.png", mime: "image/png", base64: "AQID" }],
		});
		resolveRetry({ ok: true, data: { messageId: "m1" } });
		await waitFor(() => expect(messageSend).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(screen.queryByText(zhCN.composer.imageRouteFailed)).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(composer).toHaveValue(""));
		expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).not.toHaveTextContent(
			/\d/,
		);
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

	it("keeps a failed message draft and offers an explicit retry", async () => {
		const { client } = createTestClient();
		const messageSend = vi
			.fn()
			.mockRejectedValueOnce(new Error("send unavailable"))
			.mockResolvedValueOnce({ ok: true as const, data: { messageId: "m2" } });
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
		const retry = screen.getByRole("button", { name: zhCN.composer.imageRouteRetry });
		expect(retry).toBeEnabled();
		await user.click(retry);
		await waitFor(() => expect(messageSend).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(composer).toHaveValue(""));
		expect(screen.queryByText("send unavailable")).not.toBeInTheDocument();
	});
});
