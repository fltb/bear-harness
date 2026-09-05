import { i18n, useTranslation } from "@bear-harness/i18n";
import { faBoxOpen, faTrash } from "@fortawesome/free-solid-svg-icons";
import { createSignal, For, Show } from "solid-js";
import { Icon } from "../Icon.js";
import { useCompanionStore } from "../stores/companion.js";
import { useConversationWorkflow } from "../stores/conversation-workflows.js";
import { Button, Dialog } from "../ui/primitives.js";

export function ArchivedConversationSettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = useConversationWorkflow(store);
	const [deleteTarget, setDeleteTarget] = createSignal<{ id: string; title: string }>();
	const [error, setError] = createSignal<string>();
	let deleteReturnFocus: HTMLButtonElement | undefined;

	const closeDeleteDialog = () => {
		setDeleteTarget(undefined);
		queueMicrotask(() => {
			if (deleteReturnFocus?.isConnected) deleteReturnFocus.focus();
		});
	};

	const run = async (action: () => Promise<unknown>): Promise<void> => {
		setError(undefined);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<section class="settings-page-section" aria-labelledby="archived-conversations-title">
			<header class="settings-page-header">
				<h3 id="archived-conversations-title">{t("sidebar.archivedConversations")}</h3>
				<p>{t("settings.archivedConversationsHint")}</p>
			</header>
			<Show when={error()}>
				{(message) => (
					<p class="status-line err" role="alert">
						{message()}
					</p>
				)}
			</Show>
			<Show
				when={(store.archivedConversations?.length ?? 0) > 0}
				fallback={<p class="empty-note">{t("sidebar.emptyArchivedConversations")}</p>}
			>
				<div class="archived-conversation-list">
					<For each={store.archivedConversations ?? []}>
						{(conversation) => (
							<article class="archived-conversation-row">
								<div>
									<strong>{conversation.name ?? conversation.firstMessage}</strong>
									<span>{workflow.sceneLabel(conversation.conversationId)}</span>
								</div>
								<div class="archived-conversation-actions">
									<Button
										data-control="command"
										type="button"
										aria-label={t("sidebar.restoreConversation")}
										title={t("sidebar.restoreConversation")}
										onClick={() =>
											void run(() => store.restoreConversation(conversation.conversationId))
										}
									>
										<Icon icon={faBoxOpen} />
									</Button>
									<Button
										data-control="command"
										class="danger-action"
										type="button"
										aria-label={t("sidebar.deleteConversation")}
										title={t("sidebar.deleteConversation")}
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
							</article>
						)}
					</For>
				</div>
			</Show>
			<Dialog
				open={deleteTarget() !== undefined}
				onOpenChange={(open) => !open && closeDeleteDialog()}
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
									if (target) void run(() => store.deleteConversation(target.id));
								}}
							>
								{t("sidebar.deleteConversationConfirmAction")}
							</Dialog.CloseButton>
						</div>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
		</section>
	);
}
