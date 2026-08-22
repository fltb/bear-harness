import type { CompanionClient } from "@bear-harness/companion-client";
import { I18nextProvider, i18n, useLanguage, useTranslation } from "@bear-harness/i18n";
import type { ProductConfig } from "@bear-harness/product-config";
import { Button } from "@kobalte/core/button";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createEffect, createMemo, Show } from "solid-js";
import {
	createShellWorkflowStore,
	ShellWorkflowProvider,
	useShellWorkflowStore,
} from "./stores/shell-workflows.js";
import { CharacterPresence, type CharacterPresenceLayoutMode } from "./CharacterPresence";
import { Composer } from "./Composer";
import { ConversationPanel } from "./ConversationPanel";
import { FirstMeeting } from "./FirstMeeting";
import { Backstage } from "./features/Backstage.js";
import { ResultSpace, ResultSpaceProvider, useResultSpace } from "./features/ResultSpace.js";
import { SceneBackdrop } from "./SceneBackdrop";
import { Sidebar } from "./Sidebar";
import { createCompanionStore, DesktopProvider, type PresenceState, useCompanionStore } from "./stores/companion.js";

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
export function CompanionApp(props: { product: Readonly<ProductConfig>; client: CompanionClient }) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<CompanionRuntime product={props.product} client={props.client} />
			</QueryClientProvider>
		</I18nextProvider>
	);
}

function CompanionRuntime(props: { product: Readonly<ProductConfig>; client: CompanionClient }) {
	const [t] = useTranslation(undefined, { i18n });
	const [currentLocale] = useLanguage(() => i18n);
	const store = createCompanionStore(props.client);
	const workflow = createShellWorkflowStore({ store, currentLocale, translate: t });

	createEffect(() => {
		document.title = props.product.productName;
	});

	return (
		<DesktopProvider store={store}>
			<ShellWorkflowProvider workflow={workflow}>
				<ResultSpaceProvider>
					<DesktopFrame product={props.product} />
				</ResultSpaceProvider>
			</ShellWorkflowProvider>
		</DesktopProvider>
	);
}

/**
 * The Prototype 06 desktop frame: sidebar + conversation stage, plus the
 * per-conversation ResultSpace right column. `data-result-open` is the
 * layout state that makes the character/conversation/composer column yield
 * to the result column (see styles.css).
 */
type DesktopFrameProps = {
	product: Readonly<ProductConfig>;
};

function deriveCharacterPresenceLayout(input: {
	resultOpen: boolean;
	activeConversation: boolean;
	assistantStreaming: boolean;
	pendingUserText: string | undefined;
	presence: PresenceState;
}): CharacterPresenceLayoutMode {
	if (input.resultOpen) return "compact";
	if (
		input.activeConversation &&
		(input.assistantStreaming ||
			input.pendingUserText !== undefined ||
			input.presence === "listening" ||
			input.presence === "thinking")
	) {
		return "expanded";
	}
	return "resting";
}

function DesktopFrame(props: DesktopFrameProps) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = useShellWorkflowStore();
	const { selection } = useResultSpace();
	const resultSelection = createMemo(() => selection());
	const presenceLayout = createMemo(() =>
		deriveCharacterPresenceLayout({
			resultOpen: resultSelection() !== undefined,
			activeConversation: store.activeConversationId !== null,
			assistantStreaming: store.assistantStreaming,
			pendingUserText: store.pendingUserText,
			presence: store.presence,
		}),
	);

	return (
		<div
			class="app desktop-shell"
			style={workflow.themeStyle()}
			data-layout="desktop"
			data-supported-min-width={SUPPORTED_DESKTOP_MIN_WIDTH}
			data-result-open={resultSelection() ? "true" : undefined}
			role="application"
			aria-label={props.product.productName}
		>
			<div class="shell">
				<Sidebar character={workflow.character()} onOpenBackstage={workflow.openBackstage} />
				<main class="main">
					<Show when={workflow.showLanguageWarning()}>
						<section class="language-warning" role="status">
							<div>
								<strong>{t("language.warningTitle")}</strong>
								<p>{workflow.languageWarning()}</p>
							</div>
							<Button data-control="command" type="button" onClick={workflow.dismissLanguageWarning}>
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
					<ConversationPanel character={workflow.character()} />
					<Show when={store.story.proposals()[0]}>
						{(proposal) => (
							<section class="story-confirmation" aria-live="polite">
								<div>
									<strong>{props.product.productName}</strong>
									<p>{t("composer.storyConfirmation")}</p>
									<blockquote>{proposal().text}</blockquote>
								</div>
								<div class="story-confirmation-actions">
									<Button
										data-control="command"
										type="button"
										onClick={() => void store.story.resolveProposal(proposal().id, true)}
									>
										{t("composer.storyAccept")}
									</Button>
									<Button
										data-control="command"
										type="button"
										onClick={() => void store.story.resolveProposal(proposal().id, false)}
									>
										{t("composer.storyDismiss")}
									</Button>
								</div>
							</section>
						)}
					</Show>
					<Composer
						placeholder={workflow.composerPlaceholder()}
						onOpenModelSettings={() => workflow.openBackstage("settings")}
					/>
					<FirstMeeting />
				</main>
				<ResultSpace />
			</div>
			<Backstage
				open={workflow.backstageOpen()}
				onClose={workflow.closeBackstage}
				character={workflow.character()}
				initialTab={workflow.backstageTab()}
			/>
		</div>
	);
}

