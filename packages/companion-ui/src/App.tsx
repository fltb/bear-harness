import type { CompanionClient } from "@bear-harness/companion-client";
import { I18nextProvider, i18n, useLanguage, useTranslation } from "@bear-harness/i18n";
import type { ProductConfig } from "@bear-harness/product-config";
import { faBars } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kobalte/core/button";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { CharacterPresence, type CharacterPresenceLayoutMode } from "./CharacterPresence";
import { Composer } from "./Composer";
import { ConversationPanel } from "./ConversationPanel";
import { FirstMeeting } from "./FirstMeeting";
import { AttachmentPreviewProvider } from "./features/AttachmentPreviewPanel.js";
import { Backstage } from "./features/Backstage.js";
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

export type AppLayoutMode = "mobile" | "window" | "fullscreen";

/** Canonical visual-gate viewports. Compatibility sizes are tested separately. */
export const CANONICAL_LAYOUT_VIEWPORTS = {
	mobile: { width: 390, height: 844 },
	window: { width: 1280, height: 800 },
	fullscreen: { width: 1920, height: 1080 },
} as const;

export const MOBILE_LAYOUT_MAX_WIDTH = 1099;
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
 * conversation messages, runs, onboarding, presence); this component only
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
	const [layoutMode, setLayoutMode] = createSignal<AppLayoutMode>("window");
	const [mobileNavigationOpen, setMobileNavigationOpen] = createSignal(false);
	let appRef: HTMLDivElement | undefined;

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
				<AttachmentPreviewProvider>
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
						onOpenBackstage={workflow.openBackstage}
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
							presence={store.presence}
							visualState={workflow.visualState()}
							layout={presenceLayout()}
						/>
						<ConversationPanel />
						<Composer
							placeholder={workflow.composerPlaceholder()}
							onOpenModelSettings={() => workflow.openBackstage("settings")}
						/>
						<FirstMeeting />
					</main>
				</AttachmentPreviewProvider>
			</div>
			<Backstage
				open={workflow.backstageOpen()}
				onClose={workflow.closeBackstage}
				initialTab={workflow.backstageTab()}
			/>
		</div>
	);
}
