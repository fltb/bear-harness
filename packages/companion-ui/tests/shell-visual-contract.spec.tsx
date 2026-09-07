import { zhCN } from "@bear-harness/i18n/locales";
import type { IconDefinition } from "@fortawesome/free-solid-svg-icons";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	CompanionApp,
	FULLSCREEN_LAYOUT_MIN_WIDTH,
	layoutModeForWidth,
	MOBILE_LAYOUT_MAX_WIDTH,
} from "../src/App.js";
import { CharacterPresence } from "../src/CharacterPresence.js";
import { Icon } from "../src/Icon.js";
import { SceneBackdrop } from "../src/SceneBackdrop.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { ThreadHead } from "../src/ThreadHead.js";
import { createTestClient, OFFICIAL_PRODUCT, pushPiEvent, THEMED_CHARACTER } from "./fixtures.js";

const PORTRAIT_MODEL = {
	providerId: "test-provider",
	modelId: "test-model",
	label: "Test Model",
	supportsImages: true,
	enabled: true,
	readiness: "ready" as const,
	createdAt: "2026-01-01 00:00:00",
};
function configurePortraitClient(options: { active?: boolean } = {}) {
	const { client } = createTestClient();
	const active = options.active !== false;
	const conversationId = "conversation-1";
	const summary = {
		conversationId,
		name: "Conversation",
		created: "2026-01-01T00:00:00.000Z",
		modified: "2026-01-01T00:00:00.000Z",
		messageCount: 1,
		firstMessage: "Show the result",
		isStreaming: false,
	};
	const branch = {
		latestLeafIds: ["message-1"],
		entries: [
			{
				type: "message" as const,
				id: "message-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user" as const, content: "Show the result", timestamp: 1 },
			},
		],
		hasMoreBefore: false,
	};
	const activeProjection = active
		? {
				conversationId,
				name: summary.name,
				branch,
				live: {
					isStreaming: false,
					isCompacting: false,
					isRetrying: false,
					retryAttempt: 0,
					pendingToolCallIds: [],
					steering: [],
					followUp: [],
				},
			}
		: undefined;
	const snapshot = {
		onboarding: { status: "complete" as const, stateData: { answers: {} } },
		character: THEMED_CHARACTER,
	};
	client.snapshot.get = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: snapshot as never }),
	);
	client.conversation.activeGet = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { activeConversation: activeProjection ?? null } }),
	);
	client.conversation.select = vi.fn(() => client.conversation.activeGet({}));
	client.conversation.list = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: { conversations: active ? [summary] : [] },
		}),
	);
	client.model.routeGet = vi.fn(({ conversationId: id }) =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversationId: id,
				selected: { providerId: PORTRAIT_MODEL.providerId, modelId: PORTRAIT_MODEL.modelId },
			},
		}),
	);
	return { client };
}

describe("shell visual and thread head contracts", () => {
	it("selects the correct layout on both sides of each responsive boundary", () => {
		expect(layoutModeForWidth(MOBILE_LAYOUT_MAX_WIDTH)).toBe("mobile");
		expect(layoutModeForWidth(MOBILE_LAYOUT_MAX_WIDTH + 1)).toBe("window");
		expect(layoutModeForWidth(FULLSCREEN_LAYOUT_MIN_WIDTH - 1)).toBe("window");
		expect(layoutModeForWidth(FULLSCREEN_LAYOUT_MIN_WIDTH)).toBe("fullscreen");
	});

	it("shows an explicit empty state when no work is running", async () => {
		const user = userEvent.setup();
		render(() => (
			<DesktopProvider
				store={{ activeConversationId: "conversation-1", runs: [] } as CompanionStore}
			>
				<ThreadHead sceneLabel="Idle" />
			</DesktopProvider>
		));
		const queue = screen.getByRole("button", { name: /0/ });
		await user.click(queue);
		expect(screen.getByRole("region", { name: zhCN.threadHead.runningWork })).toHaveTextContent(
			zhCN.threadHead.noRunningWork,
		);
		await user.click(queue);
		expect(
			screen.queryByRole("region", { name: zhCN.threadHead.runningWork }),
		).not.toBeInTheDocument();
	});

	it("moves focus through current work and task details, restoring it on back, Escape, and close", async () => {
		const user = userEvent.setup();
		const store = {
			activeConversationId: "conversation-1",
			runs: [
				{
					id: "run-1",
					conversationId: "conversation-1",
					triggerEntryId: "entry-1",
					executorProfile: "pi-default",
					title: "Active run",
					status: "needs_user",
					artifacts: [],
					evidence: [],
				},
				{
					id: "run-2",
					conversationId: "conversation-1",
					triggerEntryId: "entry-2",
					executorProfile: "pi-default",
					title: "Completed run",
					status: "completed",
					artifacts: [],
					evidence: [],
				},
			],
			run: {
				observeDetail: () => ({
					isPending: true,
					isFetching: true,
				}),
			},
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ThreadHead sceneLabel="Scene title" />
			</DesktopProvider>
		));

		expect(screen.getByRole("heading", { name: "Scene title" })).toBeVisible();
		const queueButton = screen.getByRole("button", { name: /1/ });
		await user.click(queueButton);
		const workMenu = screen.getByRole("region", { name: zhCN.threadHead.runningWork });
		expect(workMenu).toHaveFocus();
		expect(workMenu).toHaveTextContent(zhCN.work.timeline.runStatuses.needs_user);
		expect(workMenu).toHaveTextContent(zhCN.threadHead.recentWork);
		expect(workMenu).toHaveTextContent("Completed run");
		expect(workMenu).toHaveTextContent(zhCN.work.timeline.runStatuses.completed);
		await user.click(
			within(workMenu).getAllByRole("button", { name: zhCN.work.timeline.revealDetails })[0]!,
		);
		const details = screen.getByRole("region", { name: zhCN.work.task.details });
		expect(details).toHaveFocus();
		expect(within(details).getByRole("status")).toHaveTextContent(zhCN.work.task.loading);
		await user.click(within(details).getByRole("button", { name: zhCN.work.task.back }));
		expect(workMenu).toHaveFocus();
		await user.click(
			within(workMenu).getAllByRole("button", { name: zhCN.work.timeline.revealDetails })[0]!,
		);
		await user.keyboard("{Escape}");
		expect(
			screen.queryByRole("region", { name: zhCN.threadHead.runningWork }),
		).not.toBeInTheDocument();
		expect(queueButton).toHaveFocus();
		await user.keyboard("{Enter}");
		const reopenedWork = screen.getByRole("region", { name: zhCN.threadHead.runningWork });
		expect(screen.getByRole("region", { name: zhCN.work.task.details })).toHaveFocus();
		await user.click(within(reopenedWork).getByRole("button", { name: zhCN.work.task.close }));
		expect(reopenedWork).not.toBeInTheDocument();
		expect(queueButton).toHaveFocus();
	});

	it("renders package scene and presence assets with package-owned accessible labels", () => {
		const character = {
			...THEMED_CHARACTER,
			visual: {
				...THEMED_CHARACTER.visual,
				expressions: {
					thinking: "data:image/png;base64,dGhpbmtpbmc=",
					custom: "data:image/png;base64,Y3VzdG9t",
				},
				expressionLabels: { thinking: "Thinking", custom: "Custom expression" },
			},
		};
		render(() => (
			<>
				<SceneBackdrop
					scene={{
						id: "room",
						label: "Reading room",
						backgroundUrl: "data:image/png;base64,cm9vbQ==",
					}}
				/>
				<CharacterPresence character={character} visualState="thinking" />
			</>
		));
		expect(screen.getByRole("img", { name: "Reading room" })).toBeVisible();
		expect(screen.getByRole("img", { name: "Thinking" })).toBeVisible();

		render(() => <CharacterPresence character={character} visualState="custom" />);
		expect(screen.getByRole("img", { name: "Custom expression" })).toBeVisible();
	});

	it("keeps unlabeled scenes decorative and renders layered icon definitions", () => {
		render(() => (
			<>
				<SceneBackdrop
					scene={
						{
							id: "decorative-room",
							backgroundUrl: "data:image/png;base64,cm9vbQ==",
						} as never
					}
				/>
				<span role="img" aria-label="Layered test icon">
					<Icon
						icon={
							{
								icon: [16, 16, [], "layered-test", ["M0 0h8v8H0z", "M8 8h8v8H8z"]],
							} as IconDefinition
						}
					/>
				</span>
			</>
		));
		const scene = screen.getByRole("img", { name: "" });
		expect(scene).toHaveAttribute("aria-label", "");
		expect(
			screen.getByRole("img", { name: "Layered test icon" }).firstElementChild?.childElementCount,
		).toBe(2);
	});
});

describe("portrait layout contracts", () => {
	it("rests only when there is no active conversation", async () => {
		const { client } = configurePortraitClient({ active: false });
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const presence = await screen.findByRole("img", {
			name: THEMED_CHARACTER.visual.expressionLabels.default,
		});
		expect(presence).toHaveAttribute("data-layout-mode", "resting");
	});

	it("expands an ordinary active idle conversation", async () => {
		const { client } = configurePortraitClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const presence = await screen.findByRole("img", {
			name: THEMED_CHARACTER.visual.expressionLabels.default,
		});
		await waitFor(() => expect(presence).toHaveAttribute("data-layout-mode", "expanded"));
	});

	it.each(["pending", "streaming"] as const)(
		"keeps an active %s conversation expanded",
		async (mode) => {
			const { client } = configurePortraitClient();
			if (mode === "pending") {
				const sendGate = Promise.withResolvers<{ ok: true; data: Record<string, never> }>();
				client.message.send = vi.fn(() => sendGate.promise);
			} else {
				const projection = {
					conversationId: "conversation-1",
					name: "Conversation",
					branch: { entries: [], latestLeafIds: [], hasMoreBefore: false },
					live: {
						isStreaming: true,
						isCompacting: false,
						isRetrying: false,
						retryAttempt: 0,
						pendingToolCallIds: [],
						steering: [],
						followUp: [],
					},
				};
				client.conversation.activeGet = vi.fn(() =>
					Promise.resolve({ ok: true as const, data: { activeConversation: projection } }),
				);
			}
			render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

			const presence = await screen.findByRole("img", {
				name: THEMED_CHARACTER.visual.expressionLabels.default,
			});
			if (mode === "pending") {
				const user = userEvent.setup();
				const composer = await screen.findByRole("textbox", {
					name: zhCN.composer.messageInputLabel,
				});
				await waitFor(() => expect(composer).toBeEnabled());
				await user.type(composer, "Keep the portrait open");
				await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));
				await waitFor(() => expect(composer).toHaveValue(""));
				expect(screen.getByTestId("conversation-submission")).toHaveTextContent(
					"Keep the portrait open",
				);
			} else {
				pushPiEvent(client, {
					type: "pi",
					conversationId: "conversation-1",
					event: { type: "agent_start" },
				});
				await waitFor(() =>
					expect(
						within(screen.getByRole("main")).getByRole("status", {
							name: zhCN.messages.responding,
						}),
					).toBeVisible(),
				);
			}
			await waitFor(() => expect(presence).toHaveAttribute("data-layout-mode", "expanded"));
		},
	);
});
