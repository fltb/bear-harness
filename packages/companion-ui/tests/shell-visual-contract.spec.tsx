import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import type { IconDefinition } from "@fortawesome/free-solid-svg-icons";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	CANONICAL_LAYOUT_VIEWPORTS,
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
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";

const stylesDirectory = resolve(process.cwd(), "src/styles");
const styles = [
	readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8"),
	...readdirSync(stylesDirectory)
		.filter((file) => file.endsWith(".css"))
		.sort()
		.map((file) => readFileSync(resolve(stylesDirectory, file), "utf8")),
].join("\n");
const PORTRAIT_MODEL = {
	providerId: "test-provider",
	modelId: "test-model",
	label: "Test Model",
	supportsImages: true,
	createdAt: "2026-01-01 00:00:00",
};
function configurePortraitClient(options: { active?: boolean } = {}) {
	const { client } = createTestClient();
	const active = options.active !== false;
	const conversationId = "conversation-1";
	const summary = {
		id: conversationId,
		title: "Conversation",
		created: "2026-01-01T00:00:00.000Z",
		modified: "2026-01-01T00:00:00.000Z",
		messageCount: 1,
		firstMessage: "Show the result",
	};
	const entries = {
		entries: [
			{
				id: "message-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				kind: "message" as const,
				role: "user" as const,
				text: "Show the result",
			},
		],
	};
	const activeProjection = active
		? {
				sessionId: conversationId,
				name: summary.title,
				timeline: entries,
				live: { isStreaming: false, queuedUserMessages: [] },
			}
		: undefined;
	const snapshot = {
		eventSeq: 0,
		character: THEMED_CHARACTER,
		model: {
			pool: { models: [PORTRAIT_MODEL] },
			defaults: {
				reply: { providerId: PORTRAIT_MODEL.providerId, modelId: PORTRAIT_MODEL.modelId },
				vision: { mode: "auto" as const },
			},
		},
	};
	client.snapshot.get = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: snapshot as never }),
	);
	client.conversation.open = vi.fn(() => {
		if (!activeProjection) throw new Error("inactive fixture cannot be opened");
		return Promise.resolve({ ok: true as const, data: activeProjection });
	});
	client.conversation.list = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: { sessions: active ? [summary] : [] },
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
	it("publishes semantic surface roles and the three layout templates", () => {
		expect(CANONICAL_LAYOUT_VIEWPORTS).toEqual({
			mobile: { width: 390, height: 844 },
			window: { width: 1280, height: 800 },
			fullscreen: { width: 1920, height: 1080 },
		});
		expect(layoutModeForWidth(390)).toBe("mobile");
		expect(layoutModeForWidth(MOBILE_LAYOUT_MAX_WIDTH)).toBe("mobile");
		expect(layoutModeForWidth(MOBILE_LAYOUT_MAX_WIDTH + 1)).toBe("window");
		expect(layoutModeForWidth(FULLSCREEN_LAYOUT_MIN_WIDTH - 1)).toBe("window");
		expect(layoutModeForWidth(FULLSCREEN_LAYOUT_MIN_WIDTH)).toBe("fullscreen");
		for (const token of [
			"--surface-sidebar",
			"--surface-panel",
			"--surface-action",
			"--surface-danger",
			"--text-strong",
			"--text-soft",
			"--focus-ring",
		]) {
			expect(styles).toContain(token);
		}
		expect(styles).toContain('.app[data-layout="mobile"]');
		expect(styles).toContain('.app[data-layout="window"]');
		expect(styles).toContain('.app[data-layout="fullscreen"]');
		expect(styles).toContain('.app[data-layout="mobile"] .attachment-preview-column');
		expect(styles).toContain('.app[data-layout="window"] .attachment-preview-column');
		expect(styles).toContain('.app[data-layout="fullscreen"] .attachment-preview-column');

		render(() => (
			<div class="app" data-layout="window" role="application" aria-label="Companion">
				<div class="shell">
					<aside class="sidebar" aria-label="Conversations" />
					<main class="main">
						<section class="thread" aria-label="Conversation thread" />
						<form class="composer">
							<textarea aria-label="Message" />
						</form>
					</main>
				</div>
			</div>
		));

		const application = screen.getByRole("application", { name: "Companion" });
		expect(application).toHaveAttribute("data-layout", "window");
		expect(within(application).getAllByRole("complementary")).toHaveLength(1);
		expect(within(application).getByRole("textbox", { name: "Message" })).toBeEnabled();
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
		expect(screen.getByRole("menu", { name: zhCN.threadHead.runningWork })).toHaveTextContent(
			zhCN.threadHead.noRunningWork,
		);
		await user.click(queue);
		expect(
			screen.queryByRole("menu", { name: zhCN.threadHead.runningWork }),
		).not.toBeInTheDocument();
	});

	it("opens the active-run menu, maps status text, and closes with Escape", async () => {
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
		} as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ThreadHead sceneLabel="Scene title" />
			</DesktopProvider>
		));

		expect(screen.getByRole("heading", { name: "Scene title" })).toBeVisible();
		const queueButton = screen.getByRole("button", { name: /1/ });
		await user.click(queueButton);
		const workMenu = screen.getByRole("menu", { name: zhCN.threadHead.runningWork });
		expect(workMenu).toHaveTextContent(zhCN.work.timeline.runStatuses.needs_user);
		expect(workMenu).toHaveTextContent(zhCN.threadHead.recentWork);
		expect(workMenu).toHaveTextContent("Completed run");
		expect(workMenu).toHaveTextContent(zhCN.work.timeline.runStatuses.completed);
		await user.keyboard("{Escape}");
		expect(
			screen.queryByRole("menu", { name: zhCN.threadHead.runningWork }),
		).not.toBeInTheDocument();
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
				const sendGate = Promise.withResolvers<{ ok: true; data: { accepted: true } }>();
				client.message.send = vi.fn(() => sendGate.promise);
			} else {
				const projection = {
					sessionId: "conversation-1",
					name: "Conversation",
					timeline: { entries: [] },
					live: {
						isStreaming: true,
						streamingMessage: { text: "在想了", stopReason: "pending" as const },
						queuedUserMessages: [],
					},
				};
				client.conversation.open = vi.fn(() =>
					Promise.resolve({ ok: true as const, data: projection }),
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
				// No optimistic message: the draft stays in the composer until
				// the Pi preflight accepts the send.
				await waitFor(() => expect(composer).toHaveValue("Keep the portrait open"));
			} else {
				await waitFor(() =>
					expect(
						screen.getByRole("status", { name: zhCN.messages.responding }),
					).toBeInTheDocument(),
				);
			}
			await waitFor(() => expect(presence).toHaveAttribute("data-layout-mode", "expanded"));
		},
	);
});
