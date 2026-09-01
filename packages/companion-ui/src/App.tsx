import type { CompanionClient } from "@bear-harness/companion-client";
import { I18nextProvider, i18n, useLanguage, useTranslation } from "@bear-harness/i18n";
import type { ProductConfig } from "@bear-harness/product-config";
import type { CharacterMedia } from "@bear-harness/protocol";
import { faBars } from "@fortawesome/free-solid-svg-icons";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { CharacterPresence, type CharacterPresenceLayoutMode } from "./CharacterPresence";
import { Composer } from "./Composer";
import { ConversationPanel, MediaPreview } from "./ConversationPanel";
import { FirstMeeting } from "./FirstMeeting";
import { Backstage } from "./features/Backstage.js";
import type { SettingsPage } from "./features/SettingsSheet.js";
import { Icon } from "./Icon.js";
import { syncDocumentTitle } from "./lib/dom-effects.js";
import { SceneBackdrop } from "./SceneBackdrop";
import { Sidebar } from "./Sidebar";
import { createCompanionStore, DesktopProvider, useCompanionStore } from "./stores/companion.js";
import {
	createShellWorkflowStore,
	ShellWorkflowProvider,
	useShellWorkflowStore,
} from "./stores/shell-workflows.js";
import { Button } from "./ui/primitives.js";
import { ArtifactPreview, PermissionLayer } from "./WorkPanel.js";

export type AppLayoutMode = "mobile" | "window" | "fullscreen";

/** Canonical visual-gate viewports. Compatibility sizes are tested separately. */
export const CANONICAL_LAYOUT_VIEWPORTS = {
	mobile: { width: 390, height: 844 },
	window: { width: 1280, height: 800 },
	fullscreen: { width: 1920, height: 1080 },
} as const;

export const MOBILE_LAYOUT_MAX_WIDTH = 767;
export const FULLSCREEN_LAYOUT_MIN_WIDTH = 1600;

export function layoutModeForWidth(width: number): AppLayoutMode {
	if (width <= MOBILE_LAYOUT_MAX_WIDTH) return "mobile";
	if (width >= FULLSCREEN_LAYOUT_MIN_WIDTH) return "fullscreen";
	return "window";
}

/**
 * Desktop frame from Prototype 06, wired to the Companion store.
 *
 * The store owns the snapshot + event subscription (conversations, active
 * conversation messages, runs, and onboarding); this component only
 * composes the layout and holds the backstage sheet's open state. The
 * `client` is the injected `CompanionClient` the store is bound to.
 */
export function CompanionApp(props: {
	product: Readonly<ProductConfig>;
	client: CompanionClient;
	children?: JSX.Element;
}) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<CompanionRuntime client={props.client}>{props.children}</CompanionRuntime>
			</QueryClientProvider>
		</I18nextProvider>
	);
}

function CompanionRuntime(props: { client: CompanionClient; children?: JSX.Element }) {
	const [t] = useTranslation(undefined, { i18n });
	const [currentLocale] = useLanguage(() => i18n);
	const store = createCompanionStore(props.client);
	const workflow = createShellWorkflowStore({ store, currentLocale, translate: t });

	syncDocumentTitle(() => t("shell.productName"));

	return (
		<DesktopProvider store={store}>
			<ShellWorkflowProvider workflow={workflow}>
				<DesktopFrame />
				{props.children}
			</ShellWorkflowProvider>
		</DesktopProvider>
	);
}

function DesktopFrame() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = useShellWorkflowStore();
	const presenceLayout = createMemo<CharacterPresenceLayoutMode>(() =>
		store.activeConversationId !== null ? "expanded" : "resting",
	);
	const activityVisualState = createMemo(() => {
		if (store.runs.some((run) => run.status === "needs_user")) return "needs_user";
		if (store.runs.some((run) => run.status === "enqueued" || run.status === "running"))
			return "thinking";
		const pi = store.activePiLiveState;
		if (pi?.isStreaming || pi?.steering.length || pi?.followUp.length) return "listening";
		if (pi?.errorMessage) return "problem";
		return "presence";
	});
	const [layoutMode, setLayoutMode] = createSignal<AppLayoutMode>("window");
	const [mobileNavigationOpen, setMobileNavigationOpen] = createSignal(false);
	const [mediaSelection, setMediaSelection] = createSignal<{
		conversationId: string;
		media: CharacterMedia;
	}>();
	const [settingsPage, setSettingsPage] = createSignal<SettingsPage>("conversation");
	const previewMedia = createMemo(() => {
		const selection = mediaSelection();
		return !workflow.selectedArtifact() && selection?.conversationId === store.activeConversationId
			? selection.media
			: undefined;
	});
	let appRef: HTMLDivElement | undefined;
	let backstageReturnFocus: HTMLElement | undefined;
	const openBackstage = (tab: "roles" | "settings" | "archived") => {
		if (document.activeElement instanceof HTMLElement) {
			backstageReturnFocus = document.activeElement;
		}
		if (tab === "archived") {
			setSettingsPage("archived");
			workflow.openBackstage("settings");
			return;
		}
		if (tab === "settings") setSettingsPage("conversation");
		workflow.openBackstage(tab);
	};

	onMount(() => {
		const update = (width: number) => {
			const mode = layoutModeForWidth(width);
			setLayoutMode(mode);
			document.documentElement.dataset.appLayout = mode;
			if (mode !== "mobile") setMobileNavigationOpen(false);
		};
		update(appRef?.clientWidth ?? window.innerWidth);
		if (typeof ResizeObserver === "undefined" || !appRef) {
			const onResize = () => update(appRef?.clientWidth ?? window.innerWidth);
			window.addEventListener("resize", onResize);
			onCleanup(() => window.removeEventListener("resize", onResize));
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width;
			if (width !== undefined) update(width);
		});
		observer.observe(appRef);
		onCleanup(() => observer.disconnect());
	});
	onCleanup(() => {
		delete document.documentElement.dataset.appLayout;
	});
	const openMedia = (media: CharacterMedia) => {
		const conversationId = store.activeConversationId;
		if (!conversationId) return;
		workflow.closeArtifact();
		setMediaSelection({ conversationId, media });
	};

	return (
		<div
			ref={(element) => {
				appRef = element;
			}}
			class="app"
			style={workflow.themeStyle()}
			data-layout={layoutMode()}
			role="application"
			aria-label={t("shell.productName")}
		>
			<div class="shell" data-mobile-navigation-open={mobileNavigationOpen() ? "true" : "false"}>
				<Show when={layoutMode() === "mobile" && mobileNavigationOpen()}>
					<Button
						type="button"
						class="mobile-navigation-backdrop"
						aria-label={t("backstage.close")}
						onClick={() => setMobileNavigationOpen(false)}
					/>
				</Show>
				<Sidebar
					character={workflow.character()}
					onOpenBackstage={openBackstage}
					onNavigate={() => setMobileNavigationOpen(false)}
				/>
				<main class="main">
					<Button
						type="button"
						class="mobile-navigation-trigger"
						aria-label={t("sidebar.conversations")}
						aria-expanded={mobileNavigationOpen()}
						onClick={() => setMobileNavigationOpen((open) => !open)}
					>
						<Icon icon={faBars} />
					</Button>
					<Show when={workflow.showLanguageWarning()}>
						<section class="language-warning" role="status">
							<div>
								<strong>{t("language.warningTitle")}</strong>
								<p>{workflow.languageWarning()}</p>
							</div>
							<Button
								data-control="command"
								type="button"
								onClick={workflow.dismissLanguageWarning}
							>
								{t("language.dismiss")}
							</Button>
						</section>
					</Show>
					<SceneBackdrop scene={workflow.scene()} />
					<CharacterPresence
						character={workflow.character()}
						visualState={workflow.visualState() ?? activityVisualState()}
						layout={presenceLayout()}
					/>
					<Show
						when={store.activeConversationId !== null}
						fallback={<EmptyConversationState onCreate={() => void store.createConversation()} />}
					>
						<ConversationPanel onPreviewMedia={openMedia} />
						<Composer
							placeholder={workflow.composerPlaceholder()}
							onOpenModelSettings={() => openBackstage("settings")}
						/>
					</Show>
					<PermissionLayer />
					<FirstMeeting />
				</main>
				<Show when={previewMedia()} fallback={<ArtifactPreview />}>
					{(media) => <MediaPreview media={media()} onClose={() => setMediaSelection(undefined)} />}
				</Show>
			</div>
			<Backstage
				open={workflow.backstageOpen()}
				onClose={workflow.closeBackstage}
				initialTab={workflow.backstageTab()}
				initialSettingsPage={settingsPage()}
				returnFocus={() => backstageReturnFocus?.focus()}
			/>
		</div>
	);
}

function EmptyConversationState(props: { onCreate(): void }) {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<section class="conversation-empty-state" aria-labelledby="conversation-empty-title">
			<div class="conversation-empty-card">
				<h1 id="conversation-empty-title">{t("sidebar.noConversationTitle")}</h1>
				<p>{t("sidebar.noConversationHint")}</p>
				<Button type="button" data-variant="primary" onClick={props.onCreate}>
					{t("sidebar.createConversation")}
				</Button>
			</div>
		</section>
	);
}
