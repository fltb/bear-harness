import { productUi } from "@bear-harness/product-config";
import { For, Show } from "solid-js";
import { type CharacterDisplay, useCompanionStore } from "./stores/companion.js";

/**
 * Sidebar: identity, search (not yet wired), new-conversation, the live
 * conversation list from the store and the disabled system section.
 */
export function Sidebar(props: { character: CharacterDisplay | undefined }) {
	const store = useCompanionStore();

	return (
		<aside class="sidebar">
			<div class="identity">
				<Show when={props.character}>
					{(character) => (
						<>
							<img
								class="identity-avatar"
								src={character().visual.avatarUrl}
								alt=""
								aria-hidden="true"
								draggable={false}
							/>
							<div>
								<strong>{character().name}</strong>
								<span>{character().character.subtitle}</span>
							</div>
						</>
					)}
				</Show>
			</div>
			<div class="sidebar-tools">
				<button type="button" class="search-trigger" disabled>
					<span aria-hidden="true">⌕</span>
					<span>{productUi.sidebar.search}</span>
					<kbd>⌘K</kbd>
				</button>
				<button
					type="button"
					class="new-conversation"
					aria-label={productUi.sidebar.newConversation}
					title={productUi.sidebar.newConversation}
					onClick={() => void store.createConversation()}
				>
					＋
				</button>
			</div>
			<div class="nav-scroll">
				<nav class="nav-list" aria-label={productUi.sidebar.conversations}>
					<Show
						when={store.conversations.length > 0}
						fallback={
							<div class="conversations-empty" role="note">
								{productUi.sidebar.emptyConversations}
							</div>
						}
					>
						<For each={store.conversations}>
							{(conversation) => (
								<button
									type="button"
									class="nav-item"
									aria-current={conversation.id === store.activeConversationId ? "page" : undefined}
									onClick={() => void store.selectConversation(conversation.id)}
								>
									<strong>{conversation.title}</strong>
									<span>{conversation.sceneTitle}</span>
									<Show when={conversation.unread}>
										<span
											class="unread-dot"
											role="img"
											aria-label={productUi.sidebar.unreadMessage}
										/>
									</Show>
								</button>
							)}
						</For>
					</Show>
				</nav>
				<div class="system-section">
					<div class="section-label">{productUi.sidebar.application}</div>
					<button type="button" class="system-nav" disabled>
						<span class="gear" aria-hidden="true">
							◇
						</span>
						{productUi.sidebar.relationshipArchive}
					</button>
					<button type="button" class="system-nav" disabled>
						<span class="gear" aria-hidden="true">
							⚙
						</span>
						{productUi.sidebar.systemSettings}
					</button>
				</div>
			</div>
		</aside>
	);
}
