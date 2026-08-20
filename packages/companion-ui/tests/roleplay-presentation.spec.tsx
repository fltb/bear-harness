import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterPresence } from "../src/CharacterPresence.js";
import { ConversationPanel } from "../src/ConversationPanel.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { ROLEPLAY_MEDIA_CHARACTER, THEMED_CHARACTER } from "./fixtures.js";

describe("roleplay presentation", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("presents package choices without replacing free-text chat and triggers the declared event", async () => {
		const triggerRoleplayEvent = vi.fn(() => Promise.resolve());
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				choice_sets: [
					{
						id: "reply",
						prompt: "要回应信号吗？",
						choices: [
							{ id: "answer", label: "回应", event: "signal" },
							{ id: "wait", label: "等等", event: "wait" },
						],
					},
				],
			},
		};
		const store = {
			activeMessages: [],
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: "reply",
			activeRoleplayMediaId: undefined,
			triggerRoleplayEvent,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel character={character} />
			</DesktopProvider>
		));
		expect(screen.getByRole("region", { name: "要回应信号吗？" })).toBeVisible();
		await userEvent.setup().click(screen.getByRole("button", { name: "回应" }));
		expect(triggerRoleplayEvent).toHaveBeenCalledWith("signal");
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
			activeMessages: [],
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: "signal",
			dismissRoleplayMedia,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel character={character} />
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
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				media: [
					{
						id: "scene",
						kind,
						label: "场景媒体",
						presentation: "dialog",
						url,
						posterUrl: "data:image/png;base64,cG9zdGVy",
						captionsUrl: "data:text/vtt;base64,V0VCVlRU",
					},
				],
			},
		};
		const store = {
			activeMessages: [],
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: "scene",
			dismissRoleplayMedia: vi.fn(),
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel character={character} />
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
			activeMessages: [],
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: "signal",
			dismissRoleplayMedia: vi.fn(),
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel character={character} />
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
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				media: [
					{
						id: "inline",
						kind,
						label: "行内场景",
						presentation: "inline" as const,
						url,
						loop: false,
						captionsUrl: kind === "image" ? undefined : "data:text/vtt;base64,V0VCVlRU",
					},
				],
			},
		};
		const store = {
			activeMessages: [],
			activeConversationId: "conversation",
			conversations: [],
			runs: [],
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			activeRoleplayChoiceSetId: undefined,
			activeRoleplayMediaId: "inline",
			dismissRoleplayMedia,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel character={character} />
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

	it("keeps ambient audio independent from dialog media", async () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: false })),
		);
		const [activeMediaId, setActiveMediaId] = createSignal<string | undefined>("dialog-image");
		const dismissRoleplayMedia = vi.fn(() => setActiveMediaId(undefined));
		const dismissAmbientMedia = vi.fn();
		const store = {
			activeMessages: [],
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
			activeAmbientMediaId: "ambient-audio",
			dismissRoleplayMedia,
			dismissAmbientMedia,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel character={ROLEPLAY_MEDIA_CHARACTER} />
			</DesktopProvider>
		));

		const ambient = screen.getByRole("region", { name: "Ambient audio" });
		expect(within(ambient).getByLabelText("Ambient audio")).toHaveAttribute(
			"src",
			"data:audio/ogg;base64,YW1iaWVudA==",
		);
		expect(within(ambient).getByText("Ambient audio")).toBeVisible();
		expect(screen.getByRole("dialog")).toBeVisible();
		await userEvent.setup().click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: zhCN.messages.closeMedia,
			}),
		);
		expect(dismissRoleplayMedia).toHaveBeenCalledOnce();
		expect(dismissAmbientMedia).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(screen.getByRole("region", { name: "Ambient audio" })).toBeVisible();
		await userEvent
			.setup()
			.click(within(ambient).getByRole("button", { name: zhCN.messages.stopMedia }));
		expect(dismissAmbientMedia).toHaveBeenCalledOnce();
	});

	it("does not render a source when the active id is not declared by the character", () => {
		const store = {
			activeMessages: [],
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
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<ConversationPanel character={ROLEPLAY_MEDIA_CHARACTER} />
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
});
