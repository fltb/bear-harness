import { i18n, useTranslation } from "@bear-harness/i18n";
import {
	MAX_MESSAGE_ATTACHMENT_BYTES,
	MAX_MESSAGE_ATTACHMENTS,
} from "@bear-harness/protocol/schema";
import {
	faArrowUp,
	faChevronDown,
	faImage,
	faPaperclip,
	faStop,
} from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kobalte/core/button";
import { FileField } from "@kobalte/core/file-field";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, Show } from "solid-js";
import { Icon } from "./Icon.js";
import { ModelSelector } from "./features/ModelSelector.js";
import { useCompanionStore } from "./stores/companion.js";
import { setRequestImageReaderFocus, useConversationWorkflow } from "./stores/conversation-workflows.js";
export { requestImageReaderFocus, setRequestImageReaderFocus } from "./stores/conversation-workflows.js";

/**
 * Composer: live input wired to `message.send`. Enter sends, Shift+Enter
 * inserts a newline. Small text-based materials are read locally and sent
 * with the next message; binary documents use the Host material workflow.
 */
export function Composer(props: { placeholder: string; onOpenModelSettings?: () => void }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = useConversationWorkflow(store);
	createEffect(() => {
		const conversationId = store.activeConversationId;
		if (conversationId) workflow.refreshModels(conversationId);
	});
	const labels = () => ({
		materialLabel: t("composer.materialLabel"),
		imageLabel: t("composer.imageLabel"),
	});
	const attachmentLimitMessage = () =>
		t("composer.attachmentLimits")
			.replace("{count}", String(MAX_MESSAGE_ATTACHMENTS))
			.replace("{size}", String(MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024));
	const send = (event: SubmitEvent) => {
		event.preventDefault();
		void workflow.dispatchMessage(labels());
	};
	const retrySend = (event: MouseEvent) => {
		event.preventDefault();
		workflow.retrySend(labels());
	};
	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			const form = (event.currentTarget as HTMLTextAreaElement | null)?.form;
			form?.requestSubmit();
		}
	};
	const requestModelSettings = () => {
		setRequestImageReaderFocus(true);
		props.onOpenModelSettings?.();
	};

	return (
		<form class="composer" onSubmit={send}>
			<ModelSelector
				models={workflow.models()}
				value={workflow.selectedModel()}
				class="composer-model"
				label={t("composer.modelLabel")}
				placeholder={t("composer.chooseModel")}
				labelClass="sr-only"
				disabled={
					workflow.modelBusy() ||
					store.activeConversationId === null ||
					workflow.models().length === 0
				}
				triggerClass="composer-model-trigger"
				contentClass="composer-model-content"
				listClass="composer-model-list"
				itemClass="composer-model-item"
				placement="top-start"
				gutter={8}
				onModelChange={(model) => void workflow.selectModel(model)}
			/>
			<Show when={workflow.modelError()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<Show when={workflow.sendError()}>
				{(error) => (
					<div class="status-line err composer-send-error" role="alert">
						<span>{error()}</span>
						<Button type="button" disabled={workflow.retryingSend()} onClick={retrySend}>
							{t("composer.imageRouteRetry")}
						</Button>
					</div>
				)}
			</Show>
			<FileField
				class="composer-attach"
				disabled={!workflow.modelSelected()}
				multiple
				maxFiles={MAX_MESSAGE_ATTACHMENTS}
				maxFileSize={MAX_MESSAGE_ATTACHMENT_BYTES}
				accept="image/*,text/*,.md,.markdown,.json,.csv,.yaml,.yml,.toml,.xml,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.sql"
				onFileChange={({ acceptedFiles, rejectedFiles }) => {
					if (rejectedFiles.length > 0) {
						workflow.setAttachmentError(attachmentLimitMessage());
						return;
					}
					void workflow.loadFiles(acceptedFiles);
				}}
			>
				<FileField.HiddenInput class="material-picker" aria-label={t("composer.attachLabel")} />
				<FileField.Trigger
					class="circle"
					aria-label={t("composer.attachLabel")}
					title={t("composer.attachTitle")}
				>
					<Show when={workflow.attachments().length > 0} fallback={<Icon icon={faPaperclip} />}>
						{workflow.attachments().length}
					</Show>
				</FileField.Trigger>
			</FileField>
			<TextField class="composer-input">
				<TextField.TextArea
					rows={1}
					placeholder={props.placeholder}
					aria-label={t("composer.messageInputLabel")}
					value={workflow.composerText()}
					onInput={(event) => workflow.setComposerText(event.currentTarget.value)}
					onKeyDown={handleKeyDown}
					disabled={store.activeConversationId === null || !workflow.modelSelected()}
				/>
			</TextField>
			<Show when={workflow.hasImages() && workflow.imageRouteError()}>
				<div class="composer-image-routing" data-state="error" role="alert">
					<Icon icon={faImage} />
					<span>{t("composer.imageRouteFailed")}</span>
					<Button type="button" disabled={workflow.retryingSend()} onClick={retrySend}>
						{t("composer.imageRouteRetry")}
					</Button>
					<Button type="button" onClick={requestModelSettings}>
						{t("composer.goToImageModelSettings")}
					</Button>
					<Button type="button" onClick={workflow.removeImages}>
						{t("composer.removeImages")}
					</Button>
				</div>
			</Show>
			<Show when={workflow.needsImageReader() && !workflow.imageRouteError()}>
				<Show when={!workflow.multimodalFallback()}>
					<div class="composer-image-routing" data-state="missing">
						<Icon icon={faImage} />
						<span>{t("composer.imageModelMissing")}</span>
						<Button type="button" onClick={requestModelSettings}>
							{t("composer.goToImageModelSettings")}
						</Button>
						<Button type="button" onClick={workflow.removeImages}>
							{t("composer.removeImages")}
						</Button>
					</div>
				</Show>
				<Show when={Boolean(workflow.multimodalFallback())}>
					<div class="composer-image-routing" role="status">
						<Icon icon={faImage} />
						<span>{workflow.imageReaderLabel()}</span>
					</div>
				</Show>
			</Show>
			<Show when={workflow.attachmentError()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<Show
				when={workflow.streaming()}
				fallback={
					<Button
						type="submit"
						class="send"
						aria-label={t("composer.sendLabel")}
						title={t("composer.sendLabel")}
						disabled={
							store.activeConversationId === null ||
							!workflow.modelSelected() ||
							!workflow.imageReaderAvailable() ||
							(workflow.composerText().trim().length === 0 && workflow.attachments().length === 0)
						}
					>
						<Icon icon={faArrowUp} />
					</Button>
				}
			>
				<Button
					type="button"
					class="send"
					aria-label={t("composer.stopLabel")}
					title={t("composer.stopLabel")}
					onClick={() => void store.abort()}
				>
					<Icon icon={faStop} />
				</Button>
			</Show>
		</form>
	);
}
