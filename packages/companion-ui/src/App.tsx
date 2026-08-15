import type { CompanionClient } from "@bear-harness/companion-types";
import { type ProductConfig, productUi } from "@bear-harness/product-config";
import { createEffect, createSignal } from "solid-js";
import { CharacterPresence } from "./CharacterPresence";
import { Composer } from "./Composer";
import { ConversationPanel } from "./ConversationPanel";
import { FirstMeeting } from "./FirstMeeting";
import { Backstage } from "./features/Backstage.js";
import { SceneBackdrop } from "./SceneBackdrop";
import { Sidebar } from "./Sidebar";
import { createCompanionStore, DesktopProvider } from "./stores/companion.js";
import { Titlebar } from "./Titlebar";

/**
 * Desktop frame from Prototype 06, wired to the Companion store.
 *
 * The store owns the snapshot + event subscription (conversations, active
 * conversation messages, runs, onboarding, presence); this component only
 * composes the layout and holds the backstage sheet's open state. The
 * `client` is the injected `CompanionClient` the store is bound to.
 */
export function CompanionApp(props: { product: Readonly<ProductConfig>; client: CompanionClient }) {
	const store = createCompanionStore(props.client);
	const [backstageOpen, setBackstageOpen] = createSignal(false);

	createEffect(() => {
		document.title = props.product.productName;
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

	return (
		<DesktopProvider store={store}>
			<div class="app">
				<Titlebar sceneTitle={sceneTitle()} onOpenBackstage={() => setBackstageOpen(true)} />
				<div class="shell">
					<Sidebar character={character()} />
					<main class="main">
						<SceneBackdrop scene={activeScene()} />
						<CharacterPresence
							character={character()}
							presence={store.presence}
							visualState={activeCharacterRuntime()?.visualState}
						/>
						<ConversationPanel character={character()} />
						<Composer placeholder={composerPlaceholder()} />
						<FirstMeeting />
					</main>
				</div>
				<Backstage
					open={backstageOpen()}
					onClose={() => setBackstageOpen(false)}
					character={character()}
				/>
			</div>
		</DesktopProvider>
	);
}
