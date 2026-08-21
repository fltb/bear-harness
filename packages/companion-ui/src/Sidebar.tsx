import { i18n, useTranslation } from "@bear-harness/i18n";
import {
	faBoxArchive,
	faGear,
	faMagnifyingGlass,
	faPen,
	faPlus,
	faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon } from "./Icon.js";
import { type CharacterDisplay, useCompanionStore } from "./stores/companion.js";

/**
 * Sidebar: identity, search, new-conversation, the live conversation list
 * and persistent application navigation.
 */
export function Sidebar(props: {
	character: CharacterDisplay | undefined;
	onOpenBackstage: (tab: "roles" | "settings") => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [query, setQuery] = createSignal("");
	const [editingId, setEditingId] = createSignal<string>();
	const [editingTitle, setEditingTitle] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	let searchRef: HTMLInputElement | undefined;
	const visibleConversations = () => {
		const needle = query().trim().toLocaleLowerCase();
		if (!needle) return store.conversations;
		return store.conversations.filter((conversation) =>
			`${conversation.title} ${conversation.sceneTitle}`.toLocaleLowerCase().includes(needle),
		);
	};
	const runAction = async (action: () => Promise<void>): Promise<void> => {
		setError(null);
		const before = store.errorMetadata;
		try {
			await action();
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) setError(retained.message);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	createEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!event.metaKey && !event.ctrlKey) return;
			if (event.key.toLocaleLowerCase() !== "k") return;
			const targets = [
				event.target instanceof Element ? event.target : null,
				document.activeElement,
			];
			if (
				targets.some(
					(target) =>
						target instanceof HTMLElement &&
						(target.isContentEditable ||
							target.closest(
								'input, textarea, select, option, form, [contenteditable="true"], [role="dialog"], [aria-modal="true"]',
							)),
				)
			) {
				return;
			}
			event.preventDefault();
			searchRef?.focus();
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
					<Icon icon={faMagnifyingGlass} />
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
					onClick={() => void runAction(() => store.createConversation())}
				>
					<Icon icon={faPlus} />
				</Button>
			</div>
			<Show when={error()}>
				{(message) => (
					<p class="status-line err" role="alert">
						{t("messages.operationFailedPrefix")}
						{message()}
					</p>
				)}
			</Show>
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
													if (title)
														void runAction(async () => {
															await store.renameConversation(conversation.id, title);
															setEditingId();
														});
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
											onClick={() =>
												void runAction(() => store.selectConversation(conversation.id))
											}
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
												<Icon icon={faPen} />
											</Button>
											<Button
												data-control="command"
												type="button"
												title={t("sidebar.archiveConversation")}
												aria-label={t("sidebar.archiveConversation")}
												onClick={() =>
													void runAction(() => store.archiveConversation(conversation.id))
												}
											>
												<Icon icon={faBoxArchive} />
											</Button>
											<Button
												data-control="command"
												type="button"
												title={t("sidebar.deleteConversation")}
												aria-label={t("sidebar.deleteConversation")}
												onClick={() => {
													if (window.confirm(t("sidebar.deleteConversationConfirm")))
														void runAction(() => store.deleteConversation(conversation.id));
												}}
											>
												<Icon icon={faTrash} />
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
							<Icon icon={faGear} />
						</span>
						{t("sidebar.characterSettings")}
					</Button>
					<Button
						type="button"
						class="system-nav"
						onClick={() => props.onOpenBackstage("settings")}
					>
						<span class="gear" aria-hidden="true">
							<Icon icon={faGear} />
						</span>
						{t("sidebar.systemSettings")}
					</Button>
				</div>
			</div>
		</aside>
	);
}
