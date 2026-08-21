import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
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

function activeConversationSnapshot() {
	return {
		eventSeq: 0,
		onboarding: COMPLETE_ONBOARDING,
		conversation: {
			activeConversationId: "conversation-1",
			conversations: [
				{
					id: "conversation-1",
					title: "测试对话",
					sceneTitle: "测试场景",
					unread: false,
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
			messages: [
				{
					id: "assistant-1",
					role: "assistant",
					adoptedVersionId: "version-2",
					createdAt: "2026-01-01T00:00:00.000Z",
					versions: [
						{
							id: "version-1",
							role: "assistant",
							content: "旧回答",
							editedByUser: false,
							createdAt: "2026-01-01T00:00:00.000Z",
							adopted: false,
						},
						{
							id: "version-2",
							role: "assistant",
							content: "当前回答",
							editedByUser: false,
							createdAt: "2026-01-01T00:00:01.000Z",
							adopted: true,
						},
					],
				},
			],
		},
	};
}

function editedHistorySnapshot(userContent: string, assistantContent: string) {
	const snapshot = activeConversationSnapshot();
	return {
		...snapshot,
		conversation: {
			...snapshot.conversation,
			messages: [
				{
					id: "user-1",
					role: "user" as const,
					adoptedVersionId: "user-version-1",
					createdAt: "2026-01-01T00:00:00.000Z",
					versions: [
						{
							id: "user-version-1",
							role: "user" as const,
							content: userContent,
							editedByUser: userContent !== "原始问题",
							createdAt: "2026-01-01T00:00:00.000Z",
							adopted: true,
						},
					],
				},
				{
					id: "assistant-1",
					role: "assistant" as const,
					adoptedVersionId: "assistant-version-1",
					createdAt: "2026-01-01T00:00:01.000Z",
					versions: [
						{
							id: "assistant-version-1",
							role: "assistant" as const,
							content: assistantContent,
							editedByUser: false,
							createdAt: "2026-01-01T00:00:01.000Z",
							adopted: true,
						},
					],
				},
			],
		},
	};
}
function conversationProjectionSnapshot() {
	const snapshot = activeConversationSnapshot();
	return {
		...snapshot,
		conversation: {
			...snapshot.conversation,
			messages: [
				{
					id: "user-1",
					role: "user" as const,
					adoptedVersionId: "user-version-1",
					createdAt: "2026-01-01T00:00:00.000Z",
					versions: [
						{
							id: "user-version-1",
							role: "user" as const,
							content: "用户可见消息",
							editedByUser: false,
							createdAt: "2026-01-01T00:00:00.000Z",
							adopted: true,
						},
					],
				},
				{
					id: "assistant-1",
					role: "assistant" as const,
					adoptedVersionId: "assistant-version-1",
					createdAt: "2026-01-01T00:00:01.000Z",
					versions: [
						{
							id: "assistant-version-1",
							role: "assistant" as const,
							content: "助手可见消息",
							editedByUser: false,
							createdAt: "2026-01-01T00:00:01.000Z",
							adopted: true,
						},
					],
				},
				{
					id: "internal-1",
					role: "system" as const,
					adoptedVersionId: "internal-version-1",
					createdAt: "2026-01-01T00:00:02.000Z",
					versions: [
						{
							id: "internal-version-1",
							role: "system" as const,
							content: "内部工具结果",
							editedByUser: false,
							createdAt: "2026-01-01T00:00:02.000Z",
							adopted: true,
						},
					],
				},
			],
		},
	};
}

describe("conversation message projection", () => {
	it("renders only user and assistant messages in the user-facing thread", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: conversationProjectionSnapshot() }),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const thread = await screen.findByRole("region", { name: zhCN.messages.conversation });
		expect(await within(thread).findByText("用户可见消息")).toBeVisible();
		expect(await within(thread).findByText("助手可见消息")).toBeVisible();

		expect(within(thread).queryByText("内部工具结果")).not.toBeInTheDocument();
		expect(
			within(thread)
				.getAllByRole("article")
				.map((article) => article.getAttribute("data-message-id")),
		).toEqual(["user-1", "assistant-1"]);
	});
});

describe("conversation message controls", () => {
	it("waits for the boot snapshot before deciding that model setup is required", async () => {
		const { client } = createTestClient();
		let resolveSnapshot:
			| ((value: Awaited<ReturnType<typeof client.snapshot.get>>) => void)
			| undefined;
		client.snapshot.get = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveSnapshot = resolve;
				}),
		);
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { models: [] } }),
		);
		client.model.defaultsGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { vision: { mode: "auto" as const } } }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(screen.queryByRole("dialog", { name: zhCN.modelSetup.dialogLabel })).toBeNull();
		resolveSnapshot?.({
			ok: true,
			data: {
				eventSeq: 0,
				onboarding: COMPLETE_ONBOARDING,
				model: { pool: { models: [] }, defaults: { vision: { mode: "auto" } } },
			},
		});
		expect(await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel })).toBeVisible();
	});

	it("requires selecting a reply model before entering the first meeting", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		client.provider.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					providers: [
						{
							id: "test-provider",
							name: "Test Provider",
							authType: "api_key" as const,
							credentialStatus: "stored" as const,
							availableModels: [
								{
									id: "test-model",
									name: "Test Model",
									supportsImages: false,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								},
							],
							unavailable: [],
						},
					],
				},
			}),
		);
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					onboarding: {
						status: "complete" as const,
						eventSeq: 0,
						stateData: {
							schema_version: 1 as const,
							flow_version: 1,
							answers: {},
							decisions: {},
						},
					},
					model: { pool: { models: [] }, defaults: { vision: { mode: "auto" } } },
				},
			}),
		);
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { models: [] } }),
		);
		client.model.defaultsGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { vision: { mode: "auto" as const } } }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const setup = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		expect(setup).toHaveTextContent(zhCN.modelSetup.title);
		await waitFor(() => expect(client.provider.list).toHaveBeenCalled());
		const service = await screen.findByRole("button", {
			name: new RegExp(zhCN.settings.serviceLabel),
		});
		expect(service).toHaveValue("");
		expect(
			within(setup).getByRole("button", { name: new RegExp(zhCN.modelSetup.modelLabel) }),
		).toBeDisabled();
		expect(within(setup).queryByRole("button", { name: zhCN.modelSetup.continue })).toBeNull();
		await selectKobalteOption(user, service, "test-provider");
		expect(within(setup).getByRole("button", { name: zhCN.modelSetup.continue })).toBeDisabled();
		await selectKobalteOption(
			user,
			within(setup).getByRole("button", { name: new RegExp(zhCN.modelSetup.modelLabel) }),
			"test-model",
		);
		expect(within(setup).getByRole("button", { name: zhCN.modelSetup.continue })).toHaveAttribute(
			"data-variant",
			"primary",
		);
	});

	it("shows capture success status for a stable assistant message fixture", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const capture = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					memoryId: "memory-1",
					sourceEntryId: "assistant-1",
					createdBy: "user_capture" as const,
				},
			}),
		);
		client.memory.capture = capture;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: activeConversationSnapshot() }),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await screen.findByText("当前回答");
		await user.click(screen.getByRole("button", { name: zhCN.messages.rememberMoment }));

		const successStatus = await screen.findByRole("status", {
			name: zhCN.messages.rememberMoment,
		});
		expect(successStatus).toBeVisible();
		expect(successStatus).toHaveTextContent(zhCN.messages.rememberMoment);
		await waitFor(() =>
			expect(capture).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				entryId: "assistant-1",
			}),
		);
	});

	it("routes remember, version, regenerate, edit, continue and branch controls through the active conversation", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const switchVersion = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const regenerate = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const edit = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const continueMessage = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const branch = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { branchId: "branch-2" } }),
		);
		const capture = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					memoryId: "memory-1",
					sourceEntryId: "assistant-1",
					createdBy: "user_capture" as const,
				},
			}),
		);
		client.message.switchVersion = switchVersion;
		client.message.regenerate = regenerate;
		client.message.edit = edit;
		client.message.continue = continueMessage;
		client.message.branch = branch;
		client.memory.capture = capture;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: activeConversationSnapshot() }),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await screen.findByText("当前回答");
		const remember = screen.getByRole("button", { name: zhCN.messages.rememberMoment });
		remember.focus();
		expect(remember).toHaveFocus();
		await user.keyboard("{Enter}");
		await user.click(screen.getByRole("button", { name: zhCN.messages.previousVersion }));
		await user.click(screen.getByRole("button", { name: zhCN.messages.regenerate }));
		await user.click(screen.getByRole("button", { name: zhCN.messages.edit }));
		const editor = screen.getByRole("textbox", { name: zhCN.messages.editLabel });
		await user.clear(editor);
		await user.type(editor, "修订后的回答");
		await user.click(screen.getByRole("button", { name: zhCN.messages.save }));
		await user.click(screen.getByRole("button", { name: zhCN.messages.continue }));
		await user.click(screen.getByRole("button", { name: zhCN.messages.branch }));

		await waitFor(() => {
			expect(switchVersion).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				messageId: "assistant-1",
				versionId: "version-1",
			});
			expect(regenerate).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				messageId: "assistant-1",
			});
			expect(edit).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				messageId: "assistant-1",
				text: "修订后的回答",
				isUserMessage: false,
			});
			expect(capture).toHaveBeenCalledTimes(1);
			expect(capture).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				entryId: "assistant-1",
			});
			expect(continueMessage).toHaveBeenCalledWith({ conversationId: "conversation-1" });
			expect(branch).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				messageId: "assistant-1",
			});
		});
	});
	it("renders one adopted result after a user edit and one regenerate", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		let edited = false;
		let completeEdit: (() => void) | undefined;
		const edit = vi.fn(
			() =>
				new Promise<{ ok: true; data: null }>((resolve) => {
					completeEdit = () => {
						edited = true;
						resolve({ ok: true, data: null });
					};
				}),
		);
		const regenerate = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		client.message.edit = edit;
		client.message.regenerate = regenerate;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: edited
					? editedHistorySnapshot("规则：回复 EDITED_OK", "EDITED_OK")
					: editedHistorySnapshot("原始问题", "当前回答"),
			}),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await screen.findByText("原始问题");
		const userMessage = screen.getByRole("article", { name: zhCN.messages.userMeta });
		await user.click(within(userMessage).getByRole("button", { name: zhCN.messages.edit }));
		const editor = screen.getByRole("textbox", { name: zhCN.messages.editLabel });
		await user.clear(editor);
		await user.type(editor, "规则：回复 EDITED_OK");
		await user.click(screen.getByRole("button", { name: zhCN.messages.save }));
		await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
		expect(screen.getByRole("textbox", { name: zhCN.messages.editLabel })).toBeVisible();
		if (!completeEdit) throw new Error("edit did not start");
		completeEdit();
		await screen.findByText("EDITED_OK", { exact: true });
		expect(screen.getAllByText("EDITED_OK", { exact: true })).toHaveLength(1);
		const result = screen.getByText("EDITED_OK", { exact: true });
		const assistantMessage = result.closest("article");
		expect(assistantMessage).not.toBeNull();
		const assistant = assistantMessage as HTMLElement;
		await user.click(within(assistant).getByRole("button", { name: zhCN.messages.operations }));
		await user.click(within(assistant).getByRole("button", { name: zhCN.messages.regenerate }));

		await waitFor(() => expect(regenerate).toHaveBeenCalledTimes(1));
		expect(screen.getAllByText("EDITED_OK", { exact: true })).toHaveLength(1);
	});

	it("keeps a recoverable message failure local to the initiating message", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		client.message.regenerate = vi.fn(() => Promise.reject(new Error("regenerate unavailable")));
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: activeConversationSnapshot() }),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await screen.findByText("当前回答");
		await user.click(screen.getByRole("button", { name: zhCN.messages.regenerate }));

		const alerts = await screen.findAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toHaveTextContent("regenerate unavailable");
		expect(screen.queryByText(zhCN.messages.operationFailedPrefix + "regenerate unavailable")).toBe(
			alerts[0],
		);
	});
});
