import { i18n, useTranslation } from "@bear-harness/i18n";
import {
	faBoxArchive,
	faGear,
	faMagnifyingGlass,
	faPen,
	faPlus,
	faTrash,
	faXmark,
} from "@fortawesome/free-solid-svg-icons";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "./Icon.js";
import { type CharacterDisplay, useCompanionStore } from "./stores/companion.js";
import { useConversationWorkflow } from "./stores/conversation-workflows.js";
import { Button, Dialog, TextField } from "./ui/primitives.js";
/**
 * Sidebar: identity, search, new-conversation, the live conversation list
 * and persistent application navigation.
 */
export function Sidebar(props: {
	character: CharacterDisplay | undefined;
	onOpenBackstage: (tab: "roles" | "settings") => void;
	onNavigate?: () => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = useConversationWorkflow(store);
	const [deleteTarget, setDeleteTarget] = createSignal<{ id: string; title: string } | null>(null);
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
			<Button
				type="button"
				class="mobile-navigation-close"
				aria-label={`${t("backstage.close")} ${t("sidebar.conversations")}`}
				onClick={() => props.onNavigate?.()}
			>
				<Icon icon={faXmark} />
			</Button>
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
				<TextField class="search-trigger" data-testid="sidebar-search-control">
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
					onClick={() => {
						props.onNavigate?.();
						void workflow.runSidebarAction(() => store.createConversation());
					}}
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
				<nav class="nav-list" aria-label={t("sidebar.conversations")}>
					<Show
						when={workflow.visibleConversations().length > 0}
						fallback={
							<div class="conversations-empty" role="note">
								{workflow.query().trim()
									? t("sidebar.noSearchResults")
									: t("sidebar.emptyConversations")}
							</div>
						}
					>
						<For each={workflow.visibleConversations()}>
							{(conversation) => (
								<div class="nav-item-wrap">
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
														onInput={(event) => workflow.setEditingTitle(event.currentTarget.value)}
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
											onClick={() => {
												props.onNavigate?.();
												void workflow.runSidebarAction(() =>
													store.selectConversation(conversation.id),
												);
											}}
										>
											<strong>{conversation.title}</strong>
											<span>{workflow.sceneLabel(conversation.id)}</span>
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
								</div>
							)}
						</For>
					</Show>
				</nav>
				<div class="system-section">
					<div class="section-label">{t("sidebar.application")}</div>
					<Button
						type="button"
						class="system-nav"
						onClick={() => {
							props.onNavigate?.();
							props.onOpenBackstage("roles");
						}}
					>
						<span class="gear" aria-hidden="true">
							<Icon icon={faGear} />
						</span>
						{t("sidebar.characterSettings")}
					</Button>
					<Button
						type="button"
						class="system-nav"
						onClick={() => {
							props.onNavigate?.();
							props.onOpenBackstage("settings");
						}}
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
