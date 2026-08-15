import { productUi } from "@bear-harness/product-config";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { type CharacterDisplay, useCompanionStore } from "./stores/companion.js";

/**
 * Sidebar: identity, search, new-conversation, the live conversation list
 * and persistent application navigation.
 */
export function Sidebar(props: {
	character: CharacterDisplay | undefined;
	onOpenBackstage: (tab?: "relationship" | "settings") => void;
}) {
	const store = useCompanionStore();
	const [query, setQuery] = createSignal("");
	const [editingId, setEditingId] = createSignal<string>();
	const [editingTitle, setEditingTitle] = createSignal("");
	let searchRef: HTMLInputElement | undefined;
	const visibleConversations = () => {
		const needle = query().trim().toLocaleLowerCase();
		if (!needle) return store.conversations;
		return store.conversations.filter((conversation) =>
			`${conversation.title} ${conversation.sceneTitle}`.toLocaleLowerCase().includes(needle),
		);
	};

	createEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
				event.preventDefault();
				searchRef?.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		onCleanup(() => document.removeEventListener("keydown", onKeyDown));
	});

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
				<label class="search-trigger">
					<span aria-hidden="true">⌕</span>
					<input
						ref={(element) => {
							searchRef = element;
						}}
						type="search"
						aria-label={productUi.sidebar.search}
						placeholder={productUi.sidebar.search}
						value={query()}
						onInput={(event) => setQuery(event.currentTarget.value)}
					/>
					<kbd>⌘K</kbd>
				</label>
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
						when={visibleConversations().length > 0}
						fallback={
							<div class="conversations-empty" role="note">
								{productUi.sidebar.emptyConversations}
							</div>
						}
					>
						<For each={visibleConversations()}>
							{(conversation) => (
								<div class="nav-item-wrap">
									<Show
										when={editingId() !== conversation.id}
										fallback={
											<form
												class="conversation-rename"
												onSubmit={(event) => {
													event.preventDefault();
													const title = editingTitle().trim();
													if (title) void store.renameConversation(conversation.id, title);
													setEditingId();
												}}
											>
												<input
													aria-label={productUi.sidebar.renameConversation}
													value={editingTitle()}
													onInput={(event) => setEditingTitle(event.currentTarget.value)}
												/>
												<button type="submit">{productUi.sidebar.saveConversation}</button>
											</form>
										}
									>
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
												<span
													class="unread-dot"
													role="img"
													aria-label={productUi.sidebar.unreadMessage}
												/>
											</Show>
										</button>
										<div class="conversation-actions">
											<button
												type="button"
												title={productUi.sidebar.renameConversation}
												aria-label={productUi.sidebar.renameConversation}
												onClick={() => {
													setEditingTitle(conversation.title);
													setEditingId(conversation.id);
												}}
											>
												✎
											</button>
											<button
												type="button"
												title={productUi.sidebar.archiveConversation}
												aria-label={productUi.sidebar.archiveConversation}
												onClick={() => void store.archiveConversation(conversation.id)}
											>
												⌑
											</button>
											<button
												type="button"
												title={productUi.sidebar.deleteConversation}
												aria-label={productUi.sidebar.deleteConversation}
												onClick={() => {
													if (window.confirm(productUi.sidebar.deleteConversationConfirm))
														void store.deleteConversation(conversation.id);
												}}
											>
												×
											</button>
										</div>
									</Show>
								</div>
							)}
						</For>
					</Show>
				</nav>
				<div class="system-section">
					<div class="section-label">{productUi.sidebar.application}</div>
					<button
						type="button"
						class="system-nav"
						onClick={() => props.onOpenBackstage("relationship")}
					>
						<span class="gear" aria-hidden="true">
							◇
						</span>
						{productUi.sidebar.relationshipArchive}
					</button>
					<button
						type="button"
						class="system-nav"
						onClick={() => props.onOpenBackstage("settings")}
					>
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
