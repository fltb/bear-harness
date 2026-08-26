import type { CompanionClient } from "@bear-harness/companion-client";
import { I18nextProvider, i18n, useLanguage, useTranslation } from "@bear-harness/i18n";
import type { ProductConfig } from "@bear-harness/product-config";
import { Button } from "@kobalte/core/button";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createMemo, type JSX, Show } from "solid-js";
import { CharacterPresence, type CharacterPresenceLayoutMode } from "./CharacterPresence";
import { Composer } from "./Composer";
import { ConversationPanel } from "./ConversationPanel";
import { FirstMeeting } from "./FirstMeeting";
import { AttachmentPreviewProvider } from "./features/AttachmentPreviewPanel.js";
import { Backstage } from "./features/Backstage.js";
import { syncDocumentTitle } from "./lib/dom-effects.js";
import { SceneBackdrop } from "./SceneBackdrop";
import { Sidebar } from "./Sidebar";
import { createCompanionStore, DesktopProvider, useCompanionStore } from "./stores/companion.js";
import {
	createShellWorkflowStore,
	ShellWorkflowProvider,
	useShellWorkflowStore,
} from "./stores/shell-workflows.js";

/** The narrowest supported desktop viewport width, in CSS pixels. */
export const SUPPORTED_DESKTOP_MIN_WIDTH = 800;

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

	return (
		<div
			class="app desktop-shell"
			style={workflow.themeStyle()}
			data-layout="desktop"
			data-supported-min-width={SUPPORTED_DESKTOP_MIN_WIDTH}
			role="application"
			aria-label={t("shell.productName")}
		>
			<div class="shell">
				<AttachmentPreviewProvider>
					<Sidebar character={workflow.character()} onOpenBackstage={workflow.openBackstage} />
					<main class="main">
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
