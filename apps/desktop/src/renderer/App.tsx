import { createEffect, createSignal } from "solid-js";
import type { ProductConfig } from "../../product.config";
import { AuroraScene } from "./AuroraScene";
import { Composer } from "./Composer";
import { ConversationPanel } from "./ConversationPanel";
import { JizhouPresence } from "./JizhouPresence";
import { Sidebar } from "./Sidebar";
import { Titlebar } from "./Titlebar";

export type ActiveSection = "home" | "old-station";

/**
 * Idle desktop frame from Prototype 06 (thread variant).
 *
 * The only meaningful state is `activeSection`: clicking the two role-content
 * navigation items switches the selected item, the scene title and the static
 * copy. Everything else is static visual — no conversation, memory, files,
 * executors or role-package imports in this framework.
 */
export function App(props: { product: Readonly<ProductConfig> }) {
	const [activeSection, setActiveSection] = createSignal<ActiveSection>("home");

	createEffect(() => {
		document.title = props.product.productName;
	});

	const character = () => props.product.defaultCharacter;
	const sceneTitle = () =>
		activeSection() === "home" ? character().sceneTitle : character().oldStationTitle;
	const greeting = () =>
		activeSection() === "home" ? character().greeting : character().oldStationGreeting;
	const composerPlaceholder = () => `对${character().name}说点什么…`;

	return (
		<div class="app">
			<Titlebar sceneTitle={sceneTitle()} />
			<div class="shell">
				<Sidebar
					character={character()}
					activeSection={activeSection()}
					onSelect={setActiveSection}
				/>
				<main class="main">
					<AuroraScene />
					<JizhouPresence characterName={character().name} />
					<ConversationPanel
						character={character()}
						section={activeSection()}
						greeting={greeting()}
					/>
					<Composer placeholder={composerPlaceholder()} />
				</main>
			</div>
		</div>
	);
}
