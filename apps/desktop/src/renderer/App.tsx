import { createEffect, createSignal } from "solid-js";
import type { ProductConfig } from "../../product.config";
import { createCompanionStore, DesktopProvider } from "./stores/companion.js";
import { Backstage } from "./features/Backstage.js";
import { AuroraScene } from "./AuroraScene";
import { Composer } from "./Composer";
import { ConversationPanel } from "./ConversationPanel";
import { FirstMeeting } from "./FirstMeeting";
import { JizhouPresence } from "./JizhouPresence";
import { Sidebar } from "./Sidebar";
import { Titlebar } from "./Titlebar";

/**
 * Desktop frame from Prototype 06, wired to the Companion store.
 *
 * The store owns the snapshot + event subscription (conversations, active
 * conversation messages, runs, onboarding, presence); this component only
 * composes the layout and holds the backstage sheet's open state.
 */
export function App(props: { product: Readonly<ProductConfig> }) {
	const store = createCompanionStore();
	const [backstageOpen, setBackstageOpen] = createSignal(false);

	createEffect(() => {
		document.title = props.product.productName;
	});

	const character = () => props.product.defaultCharacter;

	const activeConversation = () =>
		store.conversations.find((conversation) => conversation.id === store.activeConversationId) ??
		null;

	const sceneTitle = () => activeConversation()?.sceneTitle || character().sceneTitle;
	const composerPlaceholder = () => `对${character().name}说点什么…`;

	return (
		<DesktopProvider store={store}>
			<div class="app">
				<Titlebar sceneTitle={sceneTitle()} onOpenBackstage={() => setBackstageOpen(true)} />
				<div class="shell">
					<Sidebar character={character()} />
					<main class="main">
						<AuroraScene />
						<JizhouPresence characterName={character().name} />
						<ConversationPanel character={character()} />
						<Composer placeholder={composerPlaceholder()} />
						<FirstMeeting />
					</main>
				</div>
				<Backstage open={backstageOpen()} onClose={() => setBackstageOpen(false)} />
			</div>
		</DesktopProvider>
	);
}
