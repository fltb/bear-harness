import type { CompanionClient } from "@bear-harness/companion-client";
import { I18nextProvider, i18n, useLanguage, useTranslation } from "@bear-harness/i18n";
import type { ProductConfig } from "@bear-harness/product-config";
import { Button } from "@kobalte/core/button";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createEffect, createSignal, type JSX, Show } from "solid-js";
import { CharacterPresence } from "./CharacterPresence";
import { Composer } from "./Composer";
import { ConversationPanel } from "./ConversationPanel";
import { FirstMeeting } from "./FirstMeeting";
import { Backstage } from "./features/Backstage.js";
import { ResultSpace, ResultSpaceProvider, useResultSpace } from "./features/ResultSpace.js";
import { SceneBackdrop } from "./SceneBackdrop";
import { Sidebar } from "./Sidebar";
import {
	type CharacterDisplay,
	createCompanionStore,
	DesktopProvider,
	type SceneDisplay,
	useCompanionStore,
} from "./stores/companion.js";

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
	const [backstageOpen, setBackstageOpen] = createSignal(false);
	const [backstageTab, setBackstageTab] = createSignal<"roles" | "settings">("roles");
	const [dismissedLanguageWarning, setDismissedLanguageWarning] = createSignal("");
	const openBackstage = (tab: "roles" | "settings" = "roles") => {
		setBackstageTab(tab);
		setBackstageOpen(true);
	};

	createEffect(() => {
		document.title = props.product.productName;
	});

	const character = () => store.character;
	const activeCharacterRuntime = () => {
		const conversationId = store.activeConversationId;
		return conversationId ? store.characterRuntimeByConversation[conversationId] : undefined;
	};
	const activeScene = () => {
		const identity = character();
		const sceneId = activeCharacterRuntime()?.sceneId ?? identity?.visual.defaultSceneId;
		return identity?.scenes.find((scene) => scene.id === sceneId);
	};
	const composerPlaceholder = () =>
		character()?.character.composer_placeholder ?? t("shell.fallbackComposerPlaceholder");
	const preferredLanguage = () =>
		globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language ?? currentLocale();
	const languageWarningKey = () => `${character()?.language ?? ""}|${preferredLanguage()}`;
	const hasLanguageMismatch = () => {
		const roleLanguage = character()?.language;
		if (!roleLanguage) return false;
		return (
			roleLanguage.split("-")[0]?.toLowerCase() !== preferredLanguage().split("-")[0]?.toLowerCase()
		);
	};
	const languageWarning = () =>
		t("language.warningBody")
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
			<ResultSpaceProvider>
				<DesktopFrame
					product={props.product}
					theme={themeStyle()}
					character={character()}
					scene={activeScene()}
					visualState={activeCharacterRuntime()?.visualState}
					composerPlaceholder={composerPlaceholder()}
					showLanguageWarning={
						hasLanguageMismatch() && dismissedLanguageWarning() !== languageWarningKey()
					}
					languageWarning={languageWarning()}
					onDismissLanguageWarning={() => setDismissedLanguageWarning(languageWarningKey())}
					openBackstage={openBackstage}
					backstageOpen={backstageOpen()}
					backstageTab={backstageTab()}
					onCloseBackstage={() => setBackstageOpen(false)}
				/>
			</ResultSpaceProvider>
		</DesktopProvider>
	);
}

/**
 * The Prototype 06 desktop frame: sidebar + conversation stage, plus the
 * per-conversation ResultSpace right column. `data-result-open` is the
 * layout state that makes the character/conversation/composer column yield
 * to the result column (see styles.css).
 */
function DesktopFrame(props: {
	product: Readonly<ProductConfig>;
	theme: JSX.CSSProperties;
	character: CharacterDisplay | undefined;
	scene: SceneDisplay | undefined;
	visualState?: string;
	composerPlaceholder: string;
	showLanguageWarning: boolean;
	languageWarning: string;
	onDismissLanguageWarning: () => void;
	openBackstage: (tab?: "roles" | "settings") => void;
	backstageOpen: boolean;
	backstageTab: "roles" | "settings";
	onCloseBackstage: () => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const { selection } = useResultSpace();

	return (
		<div
			class="app desktop-shell"
			style={props.theme}
			data-layout="desktop"
			data-supported-min-width={SUPPORTED_DESKTOP_MIN_WIDTH}
			data-result-open={selection() ? "true" : undefined}
			role="application"
			aria-label={props.product.productName}
		>
			<div class="shell">
				<Sidebar character={props.character} onOpenBackstage={props.openBackstage} />
				<main class="main">
					<Show when={props.showLanguageWarning}>
						<section class="language-warning" role="status">
							<div>
								<strong>{t("language.warningTitle")}</strong>
								<p>{props.languageWarning}</p>
							</div>
							<Button data-control="command" type="button" onClick={props.onDismissLanguageWarning}>
								{t("language.dismiss")}
							</Button>
						</section>
					</Show>
					<SceneBackdrop scene={props.scene} />
					<CharacterPresence
						character={props.character}
						presence={store.presence}
						visualState={props.visualState}
					/>
					<ConversationPanel character={props.character} />
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
						placeholder={props.composerPlaceholder}
						onOpenModelSettings={() => props.openBackstage("settings")}
					/>
					<FirstMeeting />
				</main>
				<ResultSpace />
			</div>
			<Backstage
				open={props.backstageOpen}
				onClose={props.onCloseBackstage}
				character={props.character}
				initialTab={props.backstageTab}
			/>
		</div>
	);
}
