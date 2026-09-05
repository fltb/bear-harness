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
	onOpenBackstage: (tab: "roles" | "settings" | "archived") => void;
	onNavigate?: () => void;
	navigationHidden?: boolean;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = useConversationWorkflow(store);
	const [deleteTarget, setDeleteTarget] = createSignal<{
		id: string;
		title: string;
	} | null>(null);
	const [deleteBusy, setDeleteBusy] = createSignal(false);
	const [renameBusy, setRenameBusy] = createSignal(false);
	let searchRef: HTMLInputElement | undefined;
	let newConversationRef: HTMLButtonElement | undefined;
	let deleteReturnFocus: HTMLButtonElement | undefined;
	let renameInputRef: HTMLInputElement | undefined;
	let renameReturnId: string | undefined;
	const conversationRefs = new Map<string, HTMLButtonElement>();
	const renameTriggerRefs = new Map<string, HTMLButtonElement>();
	const focusAfterRender = (target: () => HTMLElement | undefined) => {
		queueMicrotask(() => target()?.focus());
	};
	const cancelRename = () => {
		if (renameBusy()) return;
		const id = renameReturnId;
		workflow.cancelRename();
		focusAfterRender(() => (id ? renameTriggerRefs.get(id) : undefined));
	};
	const saveRename = async (conversationId: string) => {
		if (renameBusy()) return;
		setRenameBusy(true);
		try {
			const saved = await workflow.saveRename(conversationId);
			if (!saved) {
				focusAfterRender(() => renameInputRef);
				return;
			}
			const id = renameReturnId;
			focusAfterRender(() => (id ? renameTriggerRefs.get(id) : undefined));
		} finally {
			setRenameBusy(false);
		}
	};
	const cancelDelete = () => {
		setDeleteTarget(null);
		setDeleteBusy(false);
		focusAfterRender(() => deleteReturnFocus);
	};
	const confirmDelete = async () => {
		const target = deleteTarget();
		if (!target || deleteBusy()) return;
		setDeleteBusy(true);
		const deleted = await workflow.runSidebarAction(() => store.deleteConversation(target.id));
		setDeleteBusy(false);
		if (!deleted) return;
		setDeleteTarget(null);
		focusAfterRender(() => {
			const activeId = store.activeConversationId;
			return (activeId ? conversationRefs.get(activeId) : undefined) ?? newConversationRef;
		});
	};

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
		<aside
			id="conversation-navigation"
			class="sidebar"
			aria-hidden={props.navigationHidden ? "true" : undefined}
			inert={props.navigationHidden ? true : undefined}
		>
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
					ref={(element) => {
						newConversationRef = element;
					}}
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
			<Show when={deleteTarget() === null ? workflow.sidebarError() : null}>
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
										when={workflow.editingId() !== conversation.conversationId}
										fallback={
											<form
												class="conversation-rename"
												onKeyDown={(event) => {
													if (event.key !== "Escape") return;
													event.preventDefault();
													event.stopPropagation();
													cancelRename();
												}}
												onSubmit={(event) => {
													event.preventDefault();
													void saveRename(conversation.conversationId);
												}}
											>
												<div class="conversation-rename-field">
													<TextField>
														<TextField.Input
															ref={(element) => {
																renameInputRef = element;
																queueMicrotask(() => element.focus());
															}}
															aria-label={t("sidebar.renameConversation")}
															aria-invalid={workflow.renameRequired() || undefined}
															aria-describedby={
																workflow.renameRequired()
																	? `conversation-rename-error-${conversation.conversationId}`
																	: undefined
															}
															value={workflow.editingTitle()}
															disabled={renameBusy()}
															onInput={(event) =>
																workflow.setEditingTitle(event.currentTarget.value)
															}
														/>
													</TextField>
													<Show when={workflow.renameRequired()}>
														<p
															id={`conversation-rename-error-${conversation.conversationId}`}
															class="conversation-rename-error"
															role="alert"
														>
															{t("errors.invalidRequest")}
														</p>
													</Show>
												</div>
												<Button data-control="command" type="submit" disabled={renameBusy()}>
													{t("sidebar.saveConversation")}
												</Button>
												<Button
													data-control="command"
													type="button"
													disabled={renameBusy()}
													onClick={cancelRename}
												>
													{t("messages.cancel")}
												</Button>
											</form>
										}
									>
										<Button
											type="button"
											class="nav-item"
											data-conversation-id={conversation.conversationId}
											ref={(element) => {
												conversationRefs.set(conversation.conversationId, element);
											}}
											aria-current={
												conversation.conversationId === store.activeConversationId
													? "page"
													: undefined
											}
											onClick={() => {
												props.onNavigate?.();
												void workflow.runSidebarAction(() =>
													store.selectConversation(conversation.conversationId),
												);
											}}
										>
											<strong>
												{conversation.name ||
													conversation.firstMessage ||
													t("sidebar.newConversation")}
												<Show when={conversation.isStreaming}>
													<span
														class="conversation-running"
														role="status"
														aria-label={t("messages.responding")}
													/>
												</Show>
												<Show
													when={
														!conversation.isStreaming &&
														store.completedConversationIds.has(conversation.conversationId)
													}
												>
													<span
														class="conversation-completed"
														role="status"
														aria-label={t("sidebar.responseReady")}
													/>
												</Show>
											</strong>
											<span>{workflow.sceneLabel(conversation.conversationId)}</span>
										</Button>
										<div class="conversation-actions">
											<Button
												data-control="command"
												type="button"
												ref={(element) => {
													renameTriggerRefs.set(conversation.conversationId, element);
												}}
												title={t("sidebar.renameConversation")}
												data-tooltip={t("sidebar.renameConversation")}
												aria-label={t("sidebar.renameConversation")}
												onClick={() => {
													renameReturnId = conversation.conversationId;
													workflow.beginRename(conversation);
												}}
											>
												<Icon icon={faPen} />
											</Button>
											<Button
												data-control="command"
												type="button"
												title={t("sidebar.archiveConversationHint")}
												data-tooltip={t("sidebar.archiveConversationHint")}
												aria-label={t("sidebar.archiveConversationHint")}
												onClick={() =>
													void workflow.runSidebarAction(() =>
														store.archiveConversation(conversation.conversationId),
													)
												}
											>
												<Icon icon={faBoxArchive} />
											</Button>
											<Button
												data-control="command"
												type="button"
												title={t("sidebar.deleteConversation")}
												data-tooltip={t("sidebar.deleteConversation")}
												aria-label={t("sidebar.deleteConversation")}
												onClick={(event) => {
													deleteReturnFocus = event.currentTarget;
													setDeleteTarget({
														id: conversation.conversationId,
														title: conversation.name ?? conversation.firstMessage,
													});
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
					if (!open && deleteTarget() && !deleteBusy()) cancelDelete();
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
						<Show when={workflow.sidebarError()}>
							{(message) => (
								<p class="status-line err" role="alert">
									{t("messages.operationFailedPrefix")}
									{message()}
								</p>
							)}
						</Show>
						<div class="confirmation-actions">
							<Button
								data-control="command"
								type="button"
								aria-label={t("messages.cancel")}
								disabled={deleteBusy()}
								onClick={cancelDelete}
							>
								{t("messages.cancel")}
							</Button>
							<Button
								data-control="command"
								class="danger-action"
								type="button"
								aria-label={t("sidebar.deleteConversationConfirmAction")}
								disabled={deleteBusy()}
								onClick={() => void confirmDelete()}
							>
								{t("sidebar.deleteConversationConfirmAction")}
							</Button>
						</div>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
		</aside>
	);
}
