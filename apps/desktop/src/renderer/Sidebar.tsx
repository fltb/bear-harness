import { For, Show } from "solid-js";
import { useCompanionStore, type CharacterDisplay } from "./stores/companion.js";

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
					<span>搜索</span>
					<kbd>⌘K</kbd>
				</button>
				<button
					type="button"
					class="new-conversation"
					aria-label="新建对话"
					title="新建对话"
					onClick={() => void store.createConversation()}
				>
					＋
				</button>
			</div>
			<div class="nav-scroll">
				<nav class="nav-list" aria-label="对话">
					<Show
						when={store.conversations.length > 0}
						fallback={
							<div class="conversations-empty" role="note">
								还没有对话。点右上角的 ＋ 开始第一段。
							</div>
						}
					>
						<For each={store.conversations}>
							{(conversation) => (
								<button
									type="button"
									class="nav-item"
									aria-current={
										conversation.id === store.activeConversationId ? "page" : undefined
									}
									onClick={() => void store.selectConversation(conversation.id)}
								>
									<strong>{conversation.title}</strong>
									<span>{conversation.sceneTitle}</span>
									<Show when={conversation.unread}>
										<i class="unread-dot" aria-label="有未读消息" />
									</Show>
								</button>
							)}
						</For>
					</Show>
				</nav>
				<div class="system-section">
					<div class="section-label">应用</div>
					<button type="button" class="system-nav" disabled>
						<span class="gear" aria-hidden="true">
							◇
						</span>
						关系档案
					</button>
					<button type="button" class="system-nav" disabled>
						<span class="gear" aria-hidden="true">
							⚙
						</span>
						系统设置
					</button>
				</div>
			</div>
		</aside>
	);
}
