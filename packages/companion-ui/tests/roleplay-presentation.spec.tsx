import { zhCN } from "@bear-harness/i18n/locales";
import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterPresence } from "../src/CharacterPresence.js";
import { ConversationPanel } from "../src/ConversationPanel.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { ROLEPLAY_MEDIA_CHARACTER, THEMED_CHARACTER } from "./fixtures.js";

describe("roleplay presentation", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("does not render empty assistant rounds between visible tool results", () => {
		const store = {
			activePiTimeline: {
				entries: [
					{
						id: "empty-assistant",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						kind: "message" as const,
						role: "assistant" as const,
						text: "",
						stopReason: "toolUse" as const,
					},
					{
						id: "tool-result",
						parentId: "empty-assistant",
						timestamp: "2026-01-01T00:00:01.000Z",
						kind: "message" as const,
						role: "tool" as const,
						toolName: "host_state",
						toolCallId: "state-1",
						status: "succeeded" as const,
					},
				],
			},
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: undefined,
			character: THEMED_CHARACTER,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel />
			</DesktopProvider>
		));

		const thread = screen.getByRole("region", { name: zhCN.messages.conversation });
		expect(within(thread).getAllByRole("article")).toHaveLength(1);
		expect(within(thread).getByRole("article")).toHaveAttribute("data-pi-entry-id", "tool-result");
	});
	it("presents package choices without replacing free-text chat and triggers the declared event", async () => {
		const triggerRoleplayEvent = vi.fn(() => Promise.resolve());
		const sendMessage = vi.fn(() => Promise.resolve());
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				choice_sets: [
					{
						id: "reply",
						prompt: "要回应信号吗？",
						choices: [
							{ id: "answer", label: "回应", event: "signal", followUp: "我选择回应。" },
							{ id: "wait", label: "等等", event: "wait", followUp: "我选择再等等。" },
						],
					},
				],
			},
		};
		const store = {
			activePiTimeline: { entries: [] },
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: "reply",
			activeRoleplayMediaId: undefined,
			triggerRoleplayEvent,
			sendMessage,
			character,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel />
			</DesktopProvider>
		));
		expect(screen.getByRole("region", { name: "要回应信号吗？" })).toBeVisible();
		await userEvent.setup().click(screen.getByRole("button", { name: "回应" }));
		expect(triggerRoleplayEvent).toHaveBeenCalledWith("signal");
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith("我选择回应。"));
		expect(triggerRoleplayEvent.mock.invocationCallOrder[0]).toBeLessThan(
			sendMessage.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("opens package animation media from the active roleplay presentation event", async () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: false })),
		);
		const dismissRoleplayMedia = vi.fn();
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				media: [
					{
						id: "signal",
						kind: "animation" as const,
						label: "重新亮起的信号",
						loop: true,
						presentation: "dialog",
						url: "data:image/webp;base64,UklGRg==",
						posterUrl: "data:image/png;base64,iVBORw0KGgo=",
					},
				],
			},
		};
		const store = {
			activePiTimeline: { entries: [] },
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: "signal",
			dismissRoleplayMedia,
			character,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel />
			</DesktopProvider>
		));

		const dialog = await screen.findByRole("dialog");
		expect(screen.getByRole("img", { name: "重新亮起的信号" })).toHaveAttribute(
			"src",
			"data:image/webp;base64,UklGRg==",
		);
		await userEvent.setup().click(within(dialog).getByRole("button"));
		expect(dismissRoleplayMedia).toHaveBeenCalledOnce();
	});

	it("re-presents declared media when the active presentation returns", async () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: false })),
		);
		const [activeMediaId, setActiveMediaId] = createSignal<string | undefined>("signal");
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				media: [
					{
						id: "signal",
						kind: "animation" as const,
						label: "重新亮起的信号",
						loop: true,
						presentation: "dialog" as const,
						url: "data:image/webp;base64,UklGRg==",
						posterUrl: "data:image/png;base64,iVBORw0KGgo=",
					},
				],
			},
		};
		const store = {
			activePiTimeline: { entries: [] },
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			get activeRoleplayMediaId() {
				return activeMediaId();
			},
			activeAmbientMediaId: undefined,
			dismissRoleplayMedia: vi.fn(),
			character,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel />
			</DesktopProvider>
		));

		expect(await screen.findByRole("dialog")).toBeVisible();
		setActiveMediaId(undefined);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		setActiveMediaId("signal");
		expect(await screen.findByRole("dialog")).toBeVisible();
	});

	it.each([
		{
			kind: "image" as const,
			url: "data:image/png;base64,aW1hZ2U=",
			selector: "img",
		},
		{
			kind: "audio" as const,
			url: "data:audio/ogg;base64,YXVkaW8=",
			selector: "audio",
		},
		{
			kind: "video" as const,
			url: "data:video/webm;base64,dmlkZW8=",
			selector: "video",
		},
	])("renders package $kind media with its declared source", ({ kind, url, selector }) => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: false })),
		);
		const media =
			kind === "image"
				? {
						id: "scene",
						kind: "image" as const,
						label: "场景媒体",
						presentation: "dialog" as const,
						url,
						loop: false,
						posterUrl: "data:image/png;base64,cG9zdGVy",
					}
				: kind === "audio"
					? {
							id: "scene",
							kind: "audio" as const,
							label: "场景媒体",
							presentation: "dialog" as const,
							url,
							loop: false,
							captionsUrl: "data:text/vtt;base64,V0VCVlRU",
						}
					: {
							id: "scene",
							kind: "video" as const,
							label: "场景媒体",
							presentation: "dialog" as const,
							url,
							loop: false,
							posterUrl: "data:image/png;base64,cG9zdGVy",
							captionsUrl: "data:text/vtt;base64,V0VCVlRU",
						};
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				media: [media],
			},
		};
		const store = {
			activePiTimeline: { entries: [] },
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: "scene",
			dismissRoleplayMedia: vi.fn(),
			character,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel />
			</DesktopProvider>
		));

		const asset =
			kind === "image"
				? screen.getByRole("img", { name: "场景媒体" })
				: screen.getByLabelText("场景媒体", { selector });
		expect(asset.tagName.toLowerCase()).toBe(selector);
		expect(asset).toHaveAttribute("src", url);
		if (kind === "video") expect(asset).toHaveAttribute("poster", "data:image/png;base64,cG9zdGVy");
		if (kind !== "image")
			expect(asset.firstElementChild).toHaveAttribute("src", "data:text/vtt;base64,V0VCVlRU");
	});

	it("uses an animation poster when the user requests reduced motion", () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: true })),
		);
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				media: [
					{
						id: "signal",
						kind: "animation" as const,
						label: "重新亮起的信号",
						presentation: "dialog",
						url: "data:image/webp;base64,YW5pbWF0aW9u",
						posterUrl: "data:image/png;base64,cG9zdGVy",
					},
				],
			},
		};
		const store = {
			activePiTimeline: { entries: [] },
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: "signal",
			dismissRoleplayMedia: vi.fn(),
			character,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel />
			</DesktopProvider>
		));

		expect(screen.getByRole("img", { name: "重新亮起的信号" })).toHaveAttribute(
			"src",
			"data:image/png;base64,cG9zdGVy",
		);
	});
	it.each([
		{ kind: "image" as const, selector: "img" },
		{ kind: "audio" as const, selector: "audio" },
		{ kind: "video" as const, selector: "video" },
	])("renders declared inline $kind media with a close control", async ({ kind, selector }) => {
		const dismissRoleplayMedia = vi.fn();
		const url = `data:${kind === "image" ? "image/png" : kind === "audio" ? "audio/ogg" : "video/webm"};base64,c2NlbmU=`;
		const media =
			kind === "image"
				? {
						id: "inline",
						kind: "image" as const,
						label: "行内场景",
						presentation: "inline" as const,
						url,
						loop: false,
					}
				: kind === "audio"
					? {
							id: "inline",
							kind: "audio" as const,
							label: "行内场景",
							presentation: "inline" as const,
							url,
							loop: false,
							captionsUrl: "data:text/vtt;base64,V0VCVlRU",
						}
					: {
							id: "inline",
							kind: "video" as const,
							label: "行内场景",
							presentation: "inline" as const,
							url,
							loop: false,
							captionsUrl: "data:text/vtt;base64,V0VCVlRU",
						};
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				media: [media],
			},
		};
		const store = {
			activePiTimeline: { entries: [] },
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: "inline",
			dismissRoleplayMedia,
			character,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel />
			</DesktopProvider>
		));

		const inline = screen.getByRole("region", { name: "行内场景" });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		const asset =
			kind === "image"
				? within(inline).getByRole("img")
				: within(inline).getByLabelText("行内场景");
		expect(asset.tagName.toLowerCase()).toBe(selector);
		expect(asset).toHaveAttribute("src", url);
		if (kind !== "image") expect(asset.firstElementChild).toHaveAttribute("kind", "captions");
		await userEvent
			.setup()
			.click(within(inline).getByRole("button", { name: zhCN.messages.closeMedia }));
		expect(dismissRoleplayMedia).toHaveBeenCalledOnce();
	});

	it("renders and stops ambient audio without blocking conversation", async () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: false })),
		);
		const dismissRoleplayMedia = vi.fn();
		const dismissAmbientMedia = vi.fn();
		const store = {
			activePiTimeline: { entries: [] },
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: undefined,
			activeAmbientMediaId: "ambient-audio",
			dismissRoleplayMedia,
			dismissAmbientMedia,
			character: ROLEPLAY_MEDIA_CHARACTER,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel />
			</DesktopProvider>
		));

		const ambient = screen.getByRole("region", { name: "Ambient audio" });
		expect(within(ambient).getByLabelText("Ambient audio")).toHaveAttribute(
			"src",
			"data:audio/ogg;base64,YW1iaWVudA==",
		);
		expect(within(ambient).getByText("Ambient audio")).toBeVisible();
		await userEvent
			.setup()
			.click(within(ambient).getByRole("button", { name: zhCN.messages.stopMedia }));
		expect(dismissAmbientMedia).toHaveBeenCalledOnce();
	});

	it("does not render a source when the active id is not declared by the character", () => {
		const store = {
			activePiTimeline: { entries: [] },
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: "not-declared",
			activeAmbientMediaId: undefined,
			dismissRoleplayMedia: vi.fn(),
			dismissAmbientMedia: vi.fn(),
			character: ROLEPLAY_MEDIA_CHARACTER,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel />
			</DesktopProvider>
		));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "Ambient audio" })).not.toBeInTheDocument();
	});
});

describe("package-driven character presence", () => {
	it("renders nothing until character visuals are available", () => {
		const { container } = render(() => <CharacterPresence character={undefined} presence="idle" />);
		expect(container).toBeEmptyDOMElement();
	});

	it("falls back to the package default when a requested expression is unavailable", () => {
		render(() => (
			<CharacterPresence character={THEMED_CHARACTER} presence="idle" visualState="missing" />
		));
		const presence = screen.getByRole("img", {
			name: THEMED_CHARACTER.visual.expressionLabels[THEMED_CHARACTER.visual.defaultExpressionId],
		});
		expect(presence).toHaveAttribute("data-state", THEMED_CHARACTER.visual.defaultExpressionId);
		expect(within(presence).getByTestId("presence-asset")).toHaveAttribute(
			"src",
			THEMED_CHARACTER.visual.expressions[THEMED_CHARACTER.visual.defaultExpressionId],
		);
	});

	it.each(["expanded"] as const)(
		"publishes the %s display-only layout mode without changing task state",
		(layout) => {
			const store = {
				activeConversationId: "conversation",
				presence: "idle",
				runs: [{ id: "run-1", status: "running" }],
			} as unknown as CompanionStore;
			const taskStateBefore = {
				activeConversationId: store.activeConversationId,
				presence: store.presence,
				runs: store.runs.map((run) => ({ id: run.id, status: run.status })),
			};

			render(() => (
				<DesktopProvider store={store}>
					<CharacterPresence character={THEMED_CHARACTER} presence="idle" layout={layout} />
				</DesktopProvider>
			));

			const presence = screen.getByRole("img", {
				name: THEMED_CHARACTER.visual.expressionLabels.default,
			});
			expect(presence).toHaveAttribute("data-layout-mode", layout);
			expect({
				activeConversationId: store.activeConversationId,
				presence: store.presence,
				runs: store.runs.map((run) => ({ id: run.id, status: run.status })),
			}).toEqual(taskStateBefore);
		},
	);
	it("applies the loaded image intrinsic ratio to the display-only presence stage without changing business state", () => {
		const store = {
			activeConversationId: "conversation",
			presence: "idle",
			runs: [{ id: "run-1", status: "running" }],
		} as unknown as CompanionStore;
		const taskStateBefore = {
			activeConversationId: store.activeConversationId,
			presence: store.presence,
			runs: store.runs.map((run) => ({ id: run.id, status: run.status })),
		};

		render(() => (
			<DesktopProvider store={store}>
				<CharacterPresence character={THEMED_CHARACTER} presence="idle" layout="expanded" />
			</DesktopProvider>
		));

		const stage = screen.getByRole("img", {
			name: THEMED_CHARACTER.visual.expressionLabels.default,
		});
		const asset = within(stage).getByTestId("presence-asset");
		Object.defineProperties(asset, {
			naturalWidth: { configurable: true, value: 1200 },
			naturalHeight: { configurable: true, value: 800 },
		});
		fireEvent.load(asset);

		expect(Number.parseFloat(stage.style.getPropertyValue("--presence-aspect-ratio"))).toBeCloseTo(
			1.5,
		);
		expect({
			activeConversationId: store.activeConversationId,
			presence: store.presence,
			runs: store.runs.map((run) => ({ id: run.id, status: run.status })),
		}).toEqual(taskStateBefore);
	});
	it.each([
		[0, 800],
		[1200, 0],
		[Number.NaN, 800],
		[1200, Number.NaN],
		[Number.POSITIVE_INFINITY, 800],
		[1200, Number.POSITIVE_INFINITY],
	])(
		"does not apply a CSS ratio for invalid intrinsic dimensions (%s × %s) without changing business state",
		(naturalWidth, naturalHeight) => {
			const store = {
				activeConversationId: "conversation",
				presence: "idle",
				runs: [{ id: "run-1", status: "running" }],
			} as unknown as CompanionStore;
			const taskStateBefore = {
				activeConversationId: store.activeConversationId,
				presence: store.presence,
				runs: store.runs.map((run) => ({ id: run.id, status: run.status })),
			};

			render(() => (
				<DesktopProvider store={store}>
					<CharacterPresence character={THEMED_CHARACTER} presence="idle" layout="expanded" />
				</DesktopProvider>
			));

			const stage = screen.getByRole("img", {
				name: THEMED_CHARACTER.visual.expressionLabels.default,
			});
			const asset = within(stage).getByTestId("presence-asset");
			Object.defineProperties(asset, {
				naturalWidth: { configurable: true, value: naturalWidth },
				naturalHeight: { configurable: true, value: naturalHeight },
			});
			fireEvent.load(asset);

			expect(stage.style.getPropertyValue("--presence-aspect-ratio")).toBe("");
			expect({
				activeConversationId: store.activeConversationId,
				presence: store.presence,
				runs: store.runs.map((run) => ({ id: run.id, status: run.status })),
			}).toEqual(taskStateBefore);
		},
	);
	it("clears a loaded ratio before a keyed asset source finishes loading without changing business state", () => {
		const store = {
			activeConversationId: "conversation",
			presence: "idle",
			runs: [{ id: "run-1", status: "running" }],
		} as unknown as CompanionStore;
		const taskStateBefore = {
			activeConversationId: store.activeConversationId,
			presence: store.presence,
			runs: store.runs.map((run) => ({ id: run.id, status: run.status })),
		};
		const alternateAsset = "data:image/svg+xml;base64,PHN2Zy8+LWFsdGVybmF0ZQ==";
		const character = {
			...THEMED_CHARACTER,
			visual: {
				...THEMED_CHARACTER.visual,
				expressions: {
					...THEMED_CHARACTER.visual.expressions,
					alternate: alternateAsset,
				},
				expressionLabels: {
					...THEMED_CHARACTER.visual.expressionLabels,
					alternate: "Alternate expression",
				},
			},
		};
		const [visualState, setVisualState] = createSignal("default");

		render(() => (
			<DesktopProvider store={store}>
				<CharacterPresence
					character={character}
					presence="idle"
					visualState={visualState()}
					layout="expanded"
				/>
			</DesktopProvider>
		));

		const initialStage = screen.getByRole("img", {
			name: THEMED_CHARACTER.visual.expressionLabels.default,
		});
		const initialAsset = within(initialStage).getByTestId("presence-asset");
		Object.defineProperties(initialAsset, {
			naturalWidth: { configurable: true, value: 1200 },
			naturalHeight: { configurable: true, value: 800 },
		});
		fireEvent.load(initialAsset);
		expect(initialStage.style.getPropertyValue("--presence-aspect-ratio")).toBe("1.5");

		setVisualState("alternate");

		const nextStage = screen.getByRole("img", { name: "Alternate expression" });
		expect(nextStage).not.toBe(initialStage);
		expect(within(nextStage).getByTestId("presence-asset")).toHaveAttribute("src", alternateAsset);
		expect(nextStage.style.getPropertyValue("--presence-aspect-ratio")).toBe("");
		expect({
			activeConversationId: store.activeConversationId,
			presence: store.presence,
			runs: store.runs.map((run) => ({ id: run.id, status: run.status })),
		}).toEqual(taskStateBefore);
	});
});
