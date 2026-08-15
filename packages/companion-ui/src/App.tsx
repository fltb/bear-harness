import type { CompanionClient } from "@bear-harness/companion-types";
import { type ProductConfig, productLocale, productUi } from "@bear-harness/product-config";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createEffect, createSignal, type JSX, Show } from "solid-js";
import { CharacterPresence } from "./CharacterPresence";
import { Composer } from "./Composer";
import { ConversationPanel } from "./ConversationPanel";
import { FirstMeeting } from "./FirstMeeting";
import { Backstage } from "./features/Backstage.js";
import { SceneBackdrop } from "./SceneBackdrop";
import { Sidebar } from "./Sidebar";
import { createCompanionStore, DesktopProvider } from "./stores/companion.js";
import { Titlebar } from "./Titlebar";
import { WorkPanel } from "./WorkPanel";

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
		<QueryClientProvider client={queryClient}>
			<CompanionRuntime product={props.product} client={props.client} />
		</QueryClientProvider>
	);
}

function CompanionRuntime(props: { product: Readonly<ProductConfig>; client: CompanionClient }) {
	const store = createCompanionStore(props.client);
	const [backstageOpen, setBackstageOpen] = createSignal(false);
	const [backstageTab, setBackstageTab] = createSignal<"relationship" | "settings">("relationship");
	const [dismissedLanguageWarning, setDismissedLanguageWarning] = createSignal("");
	const openBackstage = (tab: "relationship" | "settings" = "relationship") => {
		setBackstageTab(tab);
		setBackstageOpen(true);
	};

	createEffect(() => {
		document.title = props.product.productName;
		document.documentElement.lang = productLocale;
	});

	const character = () => store.character;
	const activeConversation = () =>
		store.conversations.find((conversation) => conversation.id === store.activeConversationId);
	const activeCharacterRuntime = () => {
		const conversationId = store.activeConversationId;
		return conversationId ? store.characterRuntimeByConversation[conversationId] : undefined;
	};
	const activeScene = () => {
		const identity = character();
		const sceneId = activeCharacterRuntime()?.sceneId ?? identity?.visual.defaultSceneId;
		return identity?.scenes.find((scene) => scene.id === sceneId);
	};
	const sceneTitle = () =>
		activeConversation()?.sceneTitle ?? character()?.character.scene_title ?? "";
	const composerPlaceholder = () =>
		character()?.character.composer_placeholder ?? productUi.shell.fallbackComposerPlaceholder;
	const preferredLanguage = () =>
		globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language ?? productLocale;
	const languageWarningKey = () => `${character()?.language ?? ""}|${preferredLanguage()}`;
	const hasLanguageMismatch = () => {
		const roleLanguage = character()?.language;
		if (!roleLanguage) return false;
		return (
			roleLanguage.split("-")[0]?.toLowerCase() !== preferredLanguage().split("-")[0]?.toLowerCase()
		);
	};
	const languageWarning = () =>
		productUi.language.warningBody
			.replace("{roleLanguage}", character()?.language ?? "")
			.replace("{userLanguage}", preferredLanguage());
	const themeStyle = (): JSX.CSSProperties => {
		const theme = character()?.theme;
		if (!theme) return {};
		return {
			"--surface": theme.color.surface,
			"--surface-alt": theme.color.surface_alt,
			"--text": theme.color.text,
			"--text-muted": theme.color.text_muted,
			"--accent": theme.color.accent,
			"--line": theme.color.line,
			"--danger": theme.color.danger,
			"--amber": theme.color.amber,
			"--radius-sm": `${theme.radius.sm}px`,
			"--radius-md": `${theme.radius.md}px`,
			"--radius-lg": `${theme.radius.lg}px`,
			"--font-body": theme.font.body,
			"--font-heading": theme.font.heading,
		} as JSX.CSSProperties;
	};

	return (
		<DesktopProvider store={store}>
			<div
				class="app"
				style={themeStyle()}
				role="application"
				aria-label={props.product.productName}
			>
				<Titlebar sceneTitle={sceneTitle()} onOpenBackstage={() => openBackstage()} />
				<div class="shell">
					<Sidebar character={character()} onOpenBackstage={openBackstage} />
					<main class="main">
						<Show
							when={hasLanguageMismatch() && dismissedLanguageWarning() !== languageWarningKey()}
						>
							<section class="language-warning" role="status">
								<div>
									<strong>{productUi.language.warningTitle}</strong>
									<p>{languageWarning()}</p>
								</div>
								<button
									type="button"
									onClick={() => setDismissedLanguageWarning(languageWarningKey())}
								>
									{productUi.language.dismiss}
								</button>
							</section>
						</Show>
						<SceneBackdrop scene={activeScene()} />
						<CharacterPresence
							character={character()}
							presence={store.presence}
							visualState={activeCharacterRuntime()?.visualState}
						/>
						<ConversationPanel character={character()} />
						<Show when={store.story.proposals()[0]}>
							{(proposal) => (
								<section class="story-confirmation" aria-live="polite">
									<div>
										<strong>{props.product.productName}</strong>
										<p>{productUi.composer.storyConfirmation}</p>
										<blockquote>{proposal().text}</blockquote>
									</div>
									<div class="story-confirmation-actions">
										<button
											type="button"
											onClick={() => void store.story.resolveProposal(proposal().id, true)}
										>
											{productUi.composer.storyAccept}
										</button>
										<button
											type="button"
											onClick={() => void store.story.resolveProposal(proposal().id, false)}
										>
											{productUi.composer.storyDismiss}
										</button>
									</div>
								</section>
							)}
						</Show>
						<WorkPanel />
						<Composer placeholder={composerPlaceholder()} />
						<FirstMeeting />
					</main>
				</div>
				<Backstage
					open={backstageOpen()}
					onClose={() => setBackstageOpen(false)}
					character={character()}
					initialTab={backstageTab()}
				/>
			</div>
		</DesktopProvider>
	);
}
