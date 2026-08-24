import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp, SUPPORTED_DESKTOP_MIN_WIDTH } from "../src/App.js";
import { CharacterPresence } from "../src/CharacterPresence.js";
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
function neverSettle(): Promise<never> {
	const { promise } = Promise.withResolvers<never>();
	return promise;
}

function configurePortraitClient(options: { active?: boolean; result?: boolean } = {}) {
	const { client } = createTestClient();
	const active = options.active !== false;
	const conversationId = "conversation-1";
	const summary = {
		id: conversationId,
		title: "Conversation",
		sceneTitle: "",
		unread: false,
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const commission = {
		id: "commission-1",
		conversationId,
		triggerEntryId: "message-1",
		draft: {
			id: "draft-1",
			title: "Portrait result",
			description: "A portrait result",
			reads: [],
			writes: [],
			networkAllowed: false,
			toolNames: [],
			hash: "draft-hash",
		},
		status: "completed" as const,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const run = {
		id: "run-1",
		commissionId: commission.id,
		executorProfile: "pi",
		status: "completed" as const,
	};
	const artifact = {
		id: "artifact-1",
		logicalName: "result.txt",
		mime: "text/plain",
		bytes: 1,
		sha256: "artifact-sha",
		status: "verified" as const,
		producerRunId: run.id,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const piTimeline = {
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
				activeConversationId: conversationId,
				id: conversationId,
				title: summary.title,
				sceneTitle: summary.sceneTitle,
				piTimeline,
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
		...(activeProjection
			? {
					conversation: {
						...activeProjection,
						conversations: [summary],
					},
				}
			: {}),
		...(options.result
			? {
					commission: { commissions: [commission] },
					run: { runs: [run] },
					artifact: { artifacts: [artifact] },
				}
			: {}),
	};
	client.snapshot.get = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: snapshot as never }),
	);
	client.conversation.activeGet = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: activeProjection === undefined ? {} : { conversation: activeProjection },
		}),
	);
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
	if (options.result) {
		client.commission.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { commissions: [commission] } }),
		);
		client.run.list = vi.fn(() => Promise.resolve({ ok: true as const, data: { runs: [run] } }));
		client.artifact.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { artifacts: [artifact] } }),
		);
	}
	return { client };
}

describe("shell visual and thread head contracts", () => {
	it("publishes semantic surface roles and a narrow desktop fallback contract", () => {
		expect(SUPPORTED_DESKTOP_MIN_WIDTH).toBe(800);
		for (const token of [
			"--surface-sidebar",
			"--surface-panel",
			"--surface-action",
			"--surface-danger",
			"--text-strong",
			"--text-muted",
			"--focus-ring",
		]) {
			expect(styles).toContain(token);
		}
		expect(styles).toContain("@media (max-width: 1049px)");
		expect(styles).toContain("@media (max-width: 799px)");
		expect(styles).toContain("@apply grid-cols-4");

		render(() => (
			<div
				class="app desktop-shell"
				data-layout="desktop"
				data-supported-min-width={SUPPORTED_DESKTOP_MIN_WIDTH}
				role="application"
				aria-label="Companion"
			>
				<div class="shell">
					<aside class="sidebar" aria-label="Conversations" />
					<main class="main">
						<section class="thread" aria-label="Conversation thread" />
						<form class="composer">
							<textarea aria-label="Message" />
						</form>
					</main>
					<aside class="result-column" aria-label="Results" />
				</div>
			</div>
		));

		const application = screen.getByRole("application", { name: "Companion" });
		expect(application).toHaveAttribute("data-layout", "desktop");
		expect(application).toHaveAttribute("data-supported-min-width", "800");
		expect(within(application).getAllByRole("complementary")).toHaveLength(2);
		expect(within(application).getByRole("textbox", { name: "Message" })).toBeEnabled();
	});

	it("shows an explicit empty state when no work is running", async () => {
		const user = userEvent.setup();
		render(() => (
			<DesktopProvider store={{ runs: [] } as CompanionStore}>
				<ThreadHead sceneTitle="Idle" />
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
			runs: [
				{
					id: "run-1",
					commissionId: "commission-1",
					executorProfile: "pi",
					status: "needs_user",
				},
				{
					id: "run-2",
					commissionId: "commission-2",
					executorProfile: "pi",
					status: "completed",
				},
			],
		} as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ThreadHead sceneTitle="Scene title" />
			</DesktopProvider>
		));

		expect(screen.getByRole("heading", { name: "Scene title" })).toBeVisible();
		const queueButton = screen.getByRole("button", { name: /1/ });
		await user.click(queueButton);
		expect(screen.getByRole("menu", { name: zhCN.threadHead.runningWork })).toHaveTextContent(
			zhCN.threadHead.runStatuses.needs_user,
		);
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
				<CharacterPresence character={character} presence="thinking" />
			</>
		));
		expect(screen.getByRole("img", { name: "Reading room" })).toBeVisible();
		expect(screen.getByRole("img", { name: "Thinking" })).toBeVisible();

		render(() => <CharacterPresence character={character} presence="idle" visualState="custom" />);
		expect(screen.getByRole("img", { name: "Custom expression" })).toBeVisible();
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
				const sendGate = Promise.withResolvers<{
					ok: true;
					data: { accepted: true; sessionId: string };
				}>();
				client.message.send = vi.fn(() => sendGate.promise);
			} else {
				let projection = {
					activeConversationId: "conversation-1",
					id: "conversation-1",
					title: "Conversation",
					sceneTitle: "",
					piTimeline: { entries: [] },
					piSessionId: "session-1",
					piLiveState: { isStreaming: false },
				};
				client.conversation.activeGet = vi.fn(() =>
					Promise.resolve({ ok: true as const, data: { conversation: projection } }),
				);
				let subscription = 0;
				client.events.subscribe = vi.fn(() => {
					subscription += 1;
					if (subscription === 1) {
						projection = {
							...projection,
							piLiveState: {
								isStreaming: true,
								streamingMessage: { text: "在想了", stopReason: "pending" as const },
							},
						};
						return Promise.resolve({
							ok: true as const,
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
					}
					return neverSettle();
				});
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

	it("compacts only when ResultSpace is opened for the active conversation", async () => {
		const { client } = configurePortraitClient({ result: true });
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const presence = await screen.findByRole("img", {
			name: THEMED_CHARACTER.visual.expressionLabels.default,
		});
		const openResults = await screen.findByRole("button", {
			name: zhCN.work.timeline.viewArtifacts,
		});
		await userEvent.setup().click(openResults);
		await waitFor(() =>
			expect(
				screen.getByRole("application", { name: OFFICIAL_PRODUCT.productName }),
			).toHaveAttribute("data-result-open", "true"),
		);
		expect(presence).toHaveAttribute("data-layout-mode", "compact");
	});
});
