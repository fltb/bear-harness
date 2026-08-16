import { zhCN } from "@bear-harness/product-config/locales";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

function configureSelectedModel(client: ReturnType<typeof createTestClient>["client"]): void {
	client.model.list = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				models: [TEST_MODEL],
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
					conversation: { activeConversationId: "conversation-1" },
				},
			}),
		);
		client.model.list = vi.fn(() =>
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
					conversation: { activeConversationId: "conversation-1" },
					model: {
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
						selected: { providerId: "relay", modelId: "fast" },
					},
				},
			}),
		);
		client.model.list = vi.fn(() =>
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
			expect(client.model.select).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				providerId: "relay",
				modelId: "deep",
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
			models,
			selected: { providerId: "text-relay", modelId: "text" },
			multimodalFallback: { providerId: "vision-relay", modelId: "vision" },
		};
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: { activeConversationId: "conversation-1" },
					model: modelState,
				},
			}),
		);
		client.model.list = vi.fn(() => Promise.resolve({ ok: true as const, data: modelState }));
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
					conversation: { activeConversationId: "conversation-1" },
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
					conversation: { activeConversationId: "conversation-1" },
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
					conversation: { activeConversationId: "conversation-1" },
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
					conversation: { activeConversationId: "conversation-1" },
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
		expect(screen.getByRole("button", { name: zhCN.composer.attachLabel })).toHaveTextContent("＋");
		expect(screen.getByRole("button", { name: zhCN.composer.sendLabel })).toBeDisabled();
		expect(messageSend).not.toHaveBeenCalled();
	});
});
