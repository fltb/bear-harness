import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { t } from "./i18n.js";
import { type CharacterDisplay, useCompanionStore } from "./stores/companion.js";

/**
 * Sidebar: identity, search, new-conversation, the live conversation list
 * and persistent application navigation.
 */
export function Sidebar(props: {
	character: CharacterDisplay | undefined;
	onOpenBackstage: (tab: "roles" | "settings") => void;
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
				<TextField class="search-trigger">
					<span aria-hidden="true">⌕</span>
					<TextField.Input
						ref={(element) => {
							searchRef = element;
						}}
						type="search"
						aria-label={t("sidebar.search")}
						placeholder={t("sidebar.search")}
						value={query()}
						onInput={(event) => setQuery(event.currentTarget.value)}
					/>
					<kbd>⌘K</kbd>
				</TextField>
				<Button
					type="button"
					class="new-conversation"
					aria-label={t("sidebar.newConversation")}
					title={t("sidebar.newConversation")}
					onClick={() => void store.createConversation()}
				>
					＋
				</Button>
			</div>
			<div class="nav-scroll">
				<nav class="nav-list" aria-label={t("sidebar.conversations")}>
					<Show
						when={visibleConversations().length > 0}
						fallback={
							<div class="conversations-empty" role="note">
								{t("sidebar.emptyConversations")}
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
												<TextField>
													<TextField.Input
														aria-label={t("sidebar.renameConversation")}
														value={editingTitle()}
														onInput={(event) => setEditingTitle(event.currentTarget.value)}
													/>
												</TextField>
												<Button data-control="command" type="submit">
													{t("sidebar.saveConversation")}
												</Button>
											</form>
										}
									>
										<Button
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
													aria-label={t("sidebar.unreadMessage")}
												/>
											</Show>
										</Button>
										<div class="conversation-actions">
											<Button
												data-control="command"
												type="button"
												title={t("sidebar.renameConversation")}
												aria-label={t("sidebar.renameConversation")}
												onClick={() => {
													setEditingTitle(conversation.title);
													setEditingId(conversation.id);
												}}
											>
												✎
											</Button>
											<Button
												data-control="command"
												type="button"
												title={t("sidebar.archiveConversation")}
												aria-label={t("sidebar.archiveConversation")}
												onClick={() => void store.archiveConversation(conversation.id)}
											>
												⌑
											</Button>
											<Button
												data-control="command"
												type="button"
												title={t("sidebar.deleteConversation")}
												aria-label={t("sidebar.deleteConversation")}
												onClick={() => {
													if (window.confirm(t("sidebar.deleteConversationConfirm")))
														void store.deleteConversation(conversation.id);
												}}
											>
												×
											</Button>
										</div>
									</Show>
								</div>
							)}
						</For>
					</Show>
				</nav>
				<div class="system-section">
					<div class="section-label">{t("sidebar.application")}</div>
					<Button type="button" class="system-nav" onClick={() => props.onOpenBackstage("roles")}>
						<span class="gear" aria-hidden="true">
							◇
						</span>
						{t("sidebar.characterSettings")}
					</Button>
					<Button
						type="button"
						class="system-nav"
						onClick={() => props.onOpenBackstage("settings")}
					>
						<span class="gear" aria-hidden="true">
							⚙
						</span>
						{t("sidebar.systemSettings")}
					</Button>
				</div>
			</div>
		</aside>
	);
}
