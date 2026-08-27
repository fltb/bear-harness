import { i18n, useTranslation } from "@bear-harness/i18n";
import {
	faBoxArchive,
	faBoxOpen,
	faGear,
	faMagnifyingGlass,
	faPen,
	faPlus,
	faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kobalte/core/button";
import { Dialog } from "@kobalte/core/dialog";
import { TextField } from "@kobalte/core/text-field";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "./Icon.js";
import { type CharacterDisplay, useCompanionStore } from "./stores/companion.js";
import { useConversationWorkflow } from "./stores/conversation-workflows.js";
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
	const workflow = useConversationWorkflow(store);
	const [deleteTarget, setDeleteTarget] = createSignal<{ id: string; title: string } | null>(null);
	const [showArchived, setShowArchived] = createSignal(false);
	const displayedConversations = createMemo(() => {
		if (!showArchived()) return workflow.visibleConversations();
		const needle = workflow.query().trim().toLocaleLowerCase();
		const conversations = store.archivedConversations ?? [];
		return needle
			? conversations.filter((conversation) =>
					`${conversation.title} ${conversation.sceneTitle}`.toLocaleLowerCase().includes(needle),
				)
			: conversations;
	});
	let searchRef: HTMLInputElement | undefined;

	onMount(() => {
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
						value={workflow.query()}
						onInput={(event) => workflow.setQuery(event.currentTarget.value)}
					/>
					<kbd>Ctrl</kbd>
					<kbd>K</kbd>
				</TextField>
				<Button
					type="button"
					class="new-conversation"
					aria-label={t("sidebar.newConversation")}
					title={t("sidebar.newConversation")}
					onClick={() => void workflow.runSidebarAction(() => store.createConversation())}
				>
					<Icon icon={faPlus} />
				</Button>
			</div>
			<Show when={workflow.sidebarError()}>
				{(message) => (
					<p class="status-line err" role="alert">
						{t("messages.operationFailedPrefix")}
						{message()}
					</p>
				)}
			</Show>
			<div class="nav-scroll">
				<fieldset class="conversation-view-tabs">
					<legend class="sr-only">{t("sidebar.conversationView")}</legend>
					<Button
						type="button"
						aria-pressed={!showArchived()}
						onClick={() => setShowArchived(false)}
					>
						{t("sidebar.activeConversations")}
					</Button>
					<Button type="button" aria-pressed={showArchived()} onClick={() => setShowArchived(true)}>
						{t("sidebar.archivedConversations")}
					</Button>
				</fieldset>
				<nav class="nav-list" aria-label={t("sidebar.conversations")}>
					<Show
						when={displayedConversations().length > 0}
						fallback={
							<div class="conversations-empty" role="note">
								{showArchived()
									? t("sidebar.emptyArchivedConversations")
									: t("sidebar.emptyConversations")}
							</div>
						}
					>
						<For each={displayedConversations()}>
							{(conversation) => (
								<div class="nav-item-wrap">
									<Show when={showArchived()}>
										<div class="nav-item archived-conversation">
											<strong>{conversation.title}</strong>
											<span>{conversation.sceneTitle}</span>
										</div>
										<div class="conversation-actions archived-actions">
											<Button
												data-control="command"
												type="button"
												title={t("sidebar.restoreConversation")}
												aria-label={t("sidebar.restoreConversation")}
												onClick={() =>
													void workflow.runSidebarAction(() =>
														store.restoreConversation(conversation.id),
													)
												}
											>
												<Icon icon={faBoxOpen} />
											</Button>
											<Button
												data-control="command"
												type="button"
												title={t("sidebar.deleteConversation")}
												aria-label={t("sidebar.deleteConversation")}
												onClick={() =>
													setDeleteTarget({ id: conversation.id, title: conversation.title })
												}
											>
												<Icon icon={faTrash} />
											</Button>
										</div>
									</Show>
									<Show when={!showArchived()}>
										<Show
											when={workflow.editingId() !== conversation.id}
											fallback={
												<form
													class="conversation-rename"
													onSubmit={(event) => {
														event.preventDefault();
														void workflow.saveRename(conversation.id);
													}}
												>
													<TextField>
														<TextField.Input
															aria-label={t("sidebar.renameConversation")}
															value={workflow.editingTitle()}
															onInput={(event) =>
																workflow.setEditingTitle(event.currentTarget.value)
															}
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
													void workflow.runSidebarAction(() =>
														store.selectConversation(conversation.id),
													)
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
														workflow.beginRename(conversation);
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
														void workflow.runSidebarAction(() =>
															store.archiveConversation(conversation.id),
														)
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
														setDeleteTarget({ id: conversation.id, title: conversation.title });
													}}
												>
													<Icon icon={faTrash} />
												</Button>
											</div>
										</Show>
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
			<Dialog
				open={deleteTarget() !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteTarget(null);
				}}
			>
				<Dialog.Portal>
					<Dialog.Overlay class="confirmation-overlay" />
					<Dialog.Content class="confirmation-dialog">
						<Dialog.Title>{t("sidebar.deleteConversationTitle")}</Dialog.Title>
						<Dialog.Description>
							{deleteTarget()?.title}
							<br />
							{t("sidebar.deleteConversationConfirm")}
						</Dialog.Description>
						<div class="confirmation-actions">
							<Dialog.CloseButton
								as={Button}
								data-control="command"
								type="button"
								aria-label={t("messages.cancel")}
							>
								{t("messages.cancel")}
							</Dialog.CloseButton>
							<Dialog.CloseButton
								as={Button}
								data-control="command"
								class="danger-action"
								type="button"
								aria-label={t("sidebar.deleteConversationConfirmAction")}
								onClick={() => {
									const target = deleteTarget();
									if (!target) return;
									void workflow.runSidebarAction(() => store.deleteConversation(target.id));
								}}
							>
								{t("sidebar.deleteConversationConfirmAction")}
							</Dialog.CloseButton>
						</div>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
		</aside>
	);
}
