import { i18n, useTranslation } from "@bear-harness/i18n";
import {
	MAX_MESSAGE_ATTACHMENT_BYTES,
	MAX_MESSAGE_ATTACHMENTS,
} from "@bear-harness/protocol/schema";
import {
	faArrowUp,
	faCheck,
	faChevronDown,
	faImage,
	faPaperclip,
	faStop,
} from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kobalte/core/button";
import { FileField } from "@kobalte/core/file-field";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createSignal, Show } from "solid-js";
import { Icon } from "./Icon.js";
import { useCompanionStore } from "./stores/companion.js";
import type { ConfiguredModel } from "./stores/ipc.js";

type ComposerAttachment =
	| { kind: "text"; name: string; content: string }
	| { kind: "image"; name: string; mime: string; base64: string };

/**
 * Composer: live input wired to `message.send`. Enter sends, Shift+Enter
 * inserts a newline. Small text-based materials are read locally and sent
 * with the next message; binary documents use the Host material workflow.
 *
 * Image routing is explicit: the reply model stays untouched and a separate
 * configured image reader is shown before sending. When no reader is
 * configured, sending is blocked with a settings shortcut; when the host
 * rejects an image request, the draft and images are restored and the send
 * stays blocked until the user retries, opens settings, or removes images.
 */

/** One-shot intent: the composer asked the user to configure the image reader. */
export const [requestImageReaderFocus, setRequestImageReaderFocus] = createSignal(false);

export function Composer(props: { placeholder: string; onOpenModelSettings?: () => void }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [text, setText] = createSignal("");
	const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
	const [modelError, setModelError] = createSignal<string | null>(null);
	const [attachmentError, setAttachmentError] = createSignal<string | null>(null);
	const [imageRouteError, setImageRouteError] = createSignal(false);
	const [retryingImageRoute, setRetryingImageRoute] = createSignal(false);
	const modelSelected = () => store.model.selectedValue().length > 0;
	const selectedModel = () =>
		store.model
			.models()
			.find((model) => `${model.providerId}:${model.modelId}` === store.model.selectedValue()) ??
		null;
	const modelDisplayName = (model: ConfiguredModel) =>
		`${model.label} (${model.providerName ?? model.providerId})`;
	const multimodalFallback = () => {
		const route = store.model.data().multimodalFallback;
		return route
			? store.model
					.models()
					.find((model) => model.providerId === route.providerId && model.modelId === route.modelId)
			: undefined;
	};
	const hasImages = () => attachments().some((attachment) => attachment.kind === "image");
	const needsImageReader = () => hasImages() && selectedModel()?.supportsImages === false;
	const imageReaderAvailable = () =>
		!hasImages() || (!imageRouteError() && (!needsImageReader() || Boolean(multimodalFallback())));
	const imageReaderLabel = () => {
		const fallback = multimodalFallback();
		return fallback ? t("composer.imageReadBy").replace("{model}", modelDisplayName(fallback)) : "";
	};
	const removeImages = () => {
		setAttachments((current) => current.filter((attachment) => attachment.kind !== "image"));
	};

	createEffect(() => {
		const conversationId = store.activeConversationId;
		if (conversationId) void store.model.list(conversationId);
	});

	const dispatchMessage = (options?: { retry?: boolean }): void => {
		const retry = options?.retry === true;
		const value = text();
		if (!value.trim() && attachments().length === 0) return;
		if (!retry && !imageReaderAvailable()) return;
		if (retry && needsImageReader() && !multimodalFallback()) return;
		const draftAttachments = attachments();
		const materials = draftAttachments
			.filter((file): file is Extract<ComposerAttachment, { kind: "text" }> => file.kind === "text")
			.map((file) => `\n\n[${t("composer.materialLabel")}：${file.name}]\n${file.content}`)
			.join("");
		const images = draftAttachments
			.filter((file) => file.kind === "image")
			.map((file) => ({ name: file.name, mime: file.mime, base64: file.base64 }));
		const message =
			`${value}${materials}`.trim() ||
			images.map((image) => `[${t("composer.imageLabel")}：${image.name}]`).join("\n");
		const hadImages = images.length > 0;
		if (!retry) {
			setText("");
			setAttachments([]);
		}
		void store.sendMessage(message, hadImages ? images : undefined).then(() => {
			setRetryingImageRoute(false);
			// The store keeps `pendingUserText` until the host accepts the message.
			// If it is still set after the call settles, the image route rejected the
			// request: restore the exact draft so images and text are never silently
			// dropped or sent alone.
			if (hadImages && store.pendingUserText !== undefined) {
				setText(value);
				setAttachments(draftAttachments);
				setImageRouteError(true);
				return;
			}
			setText("");
			setAttachments([]);
			setImageRouteError(false);
		});
	};

	const send = (event: SubmitEvent) => {
		event.preventDefault();
		dispatchMessage();
	};
	const retrySend = (event: MouseEvent) => {
		event.preventDefault();
		if (retryingImageRoute() || (needsImageReader() && !multimodalFallback())) return;
		setRetryingImageRoute(true);
		dispatchMessage({ retry: true });
	};

	const chooseFiles = async (files: File[]) => {
		const loaded: ComposerAttachment[] = [];
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = "";
				for (const byte of bytes) binary += String.fromCharCode(byte);
				loaded.push({ kind: "image", name: file.name, mime: file.type, base64: btoa(binary) });
			} else {
				loaded.push({ kind: "text", name: file.name, content: await file.text() });
			}
		}
		setImageRouteError(false);
		setAttachments(loaded);
	};

	const attachmentLimitMessage = () =>
		t("composer.attachmentLimits")
			.replace("{count}", String(MAX_MESSAGE_ATTACHMENTS))
			.replace("{size}", String(MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024));
	const loadFiles = async (files: File[]): Promise<void> => {
		setAttachmentError(null);
		try {
			await chooseFiles(files);
		} catch (cause) {
			setAttachmentError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			const form = (event.currentTarget as HTMLTextAreaElement | null)?.form;
			form?.requestSubmit();
		}
	};

	/** True while a message is being sent or streamed; the send slot becomes Stop. */
	const streaming = () =>
		store.assistantStreaming ||
		(store.pendingUserText !== undefined && !(imageRouteError() && !hasImages())) ||
		store.streamingAssistantText.length > 0;
	const selectModel = async (model: ConfiguredModel | null): Promise<void> => {
		const conversationId = store.activeConversationId;
		if (!conversationId || !model) return;
		setModelError(null);
		try {
			await store.model.select(conversationId, model.providerId, model.modelId);
		} catch (cause) {
			setModelError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<form class="composer" onSubmit={send}>
			<Select<ConfiguredModel>
				options={store.model.models()}
				value={selectedModel()}
				optionValue={(model) => `${model.providerId}:${model.modelId}`}
				optionTextValue={(model) => modelDisplayName(model)}
				placeholder={
					store.model.models().length > 0 ? t("composer.chooseModel") : t("composer.noModel")
				}
				disabled={store.activeConversationId === null || store.model.models().length === 0}
				onChange={(model) => void selectModel(model)}
				itemComponent={(itemProps) => (
					<Select.Item item={itemProps.item} class="composer-model-item">
						<Select.ItemLabel>{modelDisplayName(itemProps.item.rawValue)}</Select.ItemLabel>
						<Select.ItemIndicator class="composer-model-check">
							<Icon icon={faCheck} />
						</Select.ItemIndicator>
					</Select.Item>
				)}
				class="composer-model"
				placement="top-start"
				gutter={8}
			>
				<Select.Label class="sr-only">{t("composer.modelLabel")}</Select.Label>
				<Select.Trigger class="composer-model-trigger" aria-label={t("composer.modelLabel")}>
					<Select.Value<ConfiguredModel> class="composer-model-value">
						{() => {
							const model = selectedModel();
							return model ? modelDisplayName(model) : undefined;
						}}
					</Select.Value>
					<Select.Icon class="composer-model-icon" aria-hidden="true">
						<Icon icon={faChevronDown} />
					</Select.Icon>
				</Select.Trigger>
				<Select.Portal>
					<Select.Content class="composer-model-content">
						<Select.Listbox class="composer-model-list" />
					</Select.Content>
				</Select.Portal>
			</Select>
			<Show when={modelError()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<FileField
				class="composer-attach"
				disabled={!modelSelected()}
				multiple
				maxFiles={MAX_MESSAGE_ATTACHMENTS}
				maxFileSize={MAX_MESSAGE_ATTACHMENT_BYTES}
				accept="image/*,text/*,.md,.markdown,.json,.csv,.yaml,.yml,.toml,.xml,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.sql"
				onFileChange={({ acceptedFiles, rejectedFiles }) => {
					if (rejectedFiles.length > 0) {
						setAttachmentError(attachmentLimitMessage());
						return;
					}
					void loadFiles(acceptedFiles);
				}}
			>
				<FileField.HiddenInput class="material-picker" aria-label={t("composer.attachLabel")} />
				<FileField.Trigger
					class="circle"
					aria-label={t("composer.attachLabel")}
					title={t("composer.attachTitle")}
				>
					<Show when={attachments().length > 0} fallback={<Icon icon={faPaperclip} />}>
						{attachments().length}
					</Show>
				</FileField.Trigger>
			</FileField>
			<TextField class="composer-input">
				<TextField.TextArea
					rows={1}
					placeholder={props.placeholder}
					aria-label={t("composer.messageInputLabel")}
					value={text()}
					onInput={(event) => setText(event.currentTarget.value)}
					onKeyDown={handleKeyDown}
					disabled={store.activeConversationId === null || !modelSelected()}
				/>
			</TextField>
			<Show when={hasImages() && imageRouteError()}>
				<div class="composer-image-routing" data-state="error" role="alert">
					<Icon icon={faImage} />
					<span>{t("composer.imageRouteFailed")}</span>
					<Button type="button" disabled={retryingImageRoute()} onClick={retrySend}>
						{t("composer.imageRouteRetry")}
					</Button>
					<Button
						type="button"
						onClick={() => {
							setRequestImageReaderFocus(true);
							props.onOpenModelSettings?.();
						}}
					>
						{t("composer.goToImageModelSettings")}
					</Button>
					<Button type="button" onClick={removeImages}>
						{t("composer.removeImages")}
					</Button>
				</div>
			</Show>
			<Show when={needsImageReader() && !imageRouteError()}>
				<Show when={!multimodalFallback()}>
					<div class="composer-image-routing" data-state="missing">
						<Icon icon={faImage} />
						<span>{t("composer.imageModelMissing")}</span>
						<Button
							type="button"
							onClick={() => {
								setRequestImageReaderFocus(true);
								props.onOpenModelSettings?.();
							}}
						>
							{t("composer.goToImageModelSettings")}
						</Button>
						<Button type="button" onClick={removeImages}>
							{t("composer.removeImages")}
						</Button>
					</div>
				</Show>
				<Show when={Boolean(multimodalFallback())}>
					<div class="composer-image-routing" role="status">
						<Icon icon={faImage} />
						<span>{imageReaderLabel()}</span>
					</div>
				</Show>
			</Show>
			<Show when={attachmentError()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<Show
				when={streaming()}
				fallback={
					<Button
						type="submit"
						class="send"
						aria-label={t("composer.sendLabel")}
						title={t("composer.sendLabel")}
						disabled={
							store.activeConversationId === null ||
							!modelSelected() ||
							!imageReaderAvailable() ||
							(text().trim().length === 0 && attachments().length === 0)
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
