import { i18n, useTranslation } from "@bear-harness/i18n";
import type { ConversationAttachmentSummary } from "@bear-harness/protocol";
import {
	createContext,
	createMemo,
	createSignal,
	For,
	onCleanup,
	type ParentProps,
	Show,
	useContext,
} from "solid-js";
import { useCompanionStore } from "../stores/companion.js";
import { Button } from "../ui/primitives.js";

type PreviewEntry = {
	relativePath: string;
	entryKind: "file" | "directory" | "symlink";
	mime?: string;
	bytes?: number;
	readable: boolean;
};
type Selection = {
	conversationId: string;
	attachment: ConversationAttachmentSummary;
	relativePath?: string;
	entry?: PreviewEntry;
};
type PreviewState = {
	mode?: "semantic";
	files?: PreviewEntry[];
	content?: string;
	error?: string;
};
type PreviewKind = "text" | "image" | "audio" | "video" | "pdf" | "unknown";

function isCollection(attachment: ConversationAttachmentSummary): boolean {
	return attachment.kind === "folder" || attachment.kind === "generated";
}

const IMAGE_MIMES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
]);
const AUDIO_MIMES = new Set([
	"audio/aac",
	"audio/mpeg",
	"audio/mp4",
	"audio/ogg",
	"audio/wav",
	"audio/x-wav",
	"audio/webm",
	"audio/flac",
	"audio/x-flac",
]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]);
const TEXT_MIMES = new Set([
	"application/json",
	"application/ld+json",
	"application/toml",
	"application/xml",
	"application/x-httpd-php",
	"application/x-javascript",
	"application/x-ndjson",
	"application/x-sh",
	"application/x-yaml",
]);
const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"]);
const AUDIO_EXTENSIONS = new Set([
	"aac",
	"flac",
	"m4a",
	"mp3",
	"oga",
	"ogg",
	"opus",
	"wav",
	"weba",
]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "ogv", "webm"]);
const TEXT_EXTENSIONS = new Set([
	"c",
	"cc",
	"conf",
	"cpp",
	"css",
	"csv",
	"go",
	"h",
	"html",
	"ini",
	"java",
	"js",
	"json",
	"jsonl",
	"jsx",
	"kt",
	"log",
	"md",
	"mjs",
	"php",
	"properties",
	"py",
	"rb",
	"rs",
	"sh",
	"sql",
	"svg",
	"toml",
	"ts",
	"tsx",
	"txt",
	"xml",
	"yaml",
	"yml",
]);

function selectedName(selection: Selection): string {
	return selection.relativePath?.split("/").at(-1) || selection.attachment.name;
}

function extensionOf(selection: Selection): string {
	const name = selectedName(selection);
	const separator = name.lastIndexOf(".");
	return separator > -1 ? name.slice(separator + 1).toLowerCase() : "";
}

function previewKind(selection: Selection): PreviewKind {
	const mime = selection.entry?.mime?.split(";", 1)[0]?.trim().toLowerCase();
	if (mime === "application/pdf") return "pdf";
	if (mime && IMAGE_MIMES.has(mime)) return "image";
	if (mime && AUDIO_MIMES.has(mime)) return "audio";
	if (mime && VIDEO_MIMES.has(mime)) return "video";
	if (mime && (mime.startsWith("text/") || TEXT_MIMES.has(mime))) return "text";
	if (mime && mime !== "application/octet-stream") return "unknown";
	const extension = extensionOf(selection);
	if (extension === "pdf") return "pdf";
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	if (AUDIO_EXTENSIONS.has(extension)) return "audio";
	if (VIDEO_EXTENSIONS.has(extension)) return "video";
	if (TEXT_EXTENSIONS.has(extension)) return "text";
	return "unknown";
}

function releaseObjectUrl(url: string | undefined): void {
	if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

export interface AttachmentPreviewApi {
	selection(): Selection | undefined;
	open(attachment: ConversationAttachmentSummary, relativePath?: string): Promise<void>;
	close(): void;
}

const AttachmentPreviewContext = createContext<AttachmentPreviewApi>();

export function AttachmentPreviewProvider(props: ParentProps) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [identity, setIdentity] = createSignal<{
		conversationId: string;
		attachmentId: string;
		relativePath?: string;
	}>();
	const rootFiles = () => {
		const current = identity();
		return current
			? store.attachments.readData({
					conversationId: current.conversationId,
					attachmentId: current.attachmentId,
					mode: "semantic",
				})?.files
			: undefined;
	};
	const preview = (): PreviewState => {
		const current = identity();
		return current ? (store.attachments.readData({ ...current, mode: "semantic" }) ?? {}) : {};
	};
	const selection = createMemo<Selection | undefined>(() => {
		const current = identity();
		if (!current || current.conversationId !== store.activeConversationId) return;
		const attachment = store.attachments.data(current.conversationId, current.attachmentId);
		if (!attachment) return;
		const entry = rootFiles()?.find((file) => file.relativePath === current.relativePath);
		return {
			conversationId: current.conversationId,
			attachment,
			relativePath: current.relativePath,
			entry,
		};
	});
	const [previewUrl, setPreviewUrl] = createSignal<string>();
	const [loading, setLoading] = createSignal(false);
	const [downloading, setDownloading] = createSignal(false);
	const [actionError, setActionError] = createSignal<string>();
	let requestId = 0;

	const clearPreviewUrl = (): void => {
		releaseObjectUrl(previewUrl());
		setPreviewUrl(undefined);
	};
	const close = (): void => {
		requestId += 1;
		clearPreviewUrl();
		setIdentity(undefined);
		setActionError(undefined);
		setLoading(false);
		setDownloading(false);
	};
	onCleanup(close);

	const load = async (
		attachment: ConversationAttachmentSummary,
		relativePath?: string,
		entry?: PreviewEntry,
	): Promise<void> => {
		const conversationId = store.activeConversationId;
		if (!conversationId) return;
		const currentRequest = ++requestId;
		const nextSelection: Selection = {
			conversationId,
			attachment,
			...(relativePath ? { relativePath } : {}),
			...(entry ? { entry } : {}),
		};
		clearPreviewUrl();
		setIdentity({
			conversationId,
			attachmentId: attachment.id,
			...(relativePath ? { relativePath } : {}),
		});
		setActionError(undefined);
		setDownloading(false);

		const needsTree = isCollection(attachment) && !relativePath;
		const kind = needsTree ? "unknown" : previewKind(nextSelection);

		setLoading(true);
		try {
			await store.attachments.list(conversationId, attachment.id);
			if (currentRequest !== requestId) return;
			if (kind === "unknown" && !needsTree) return;
			if (kind === "image" || kind === "audio" || kind === "video" || kind === "pdf") {
				const url = await store.attachments.url({
					conversationId,
					attachmentId: attachment.id,
					...(relativePath ? { relativePath } : {}),
					operation: "preview",
				});
				if (currentRequest !== requestId) {
					releaseObjectUrl(url);
					return;
				}
				setPreviewUrl(url);
			} else {
				await store.attachments.read({
					conversationId,
					attachmentId: attachment.id,
					...(relativePath ? { relativePath } : {}),
					mode: "semantic",
				});
				if (currentRequest !== requestId) return;
			}
		} catch {
			if (currentRequest !== requestId) return;
			setActionError(
				kind === "image" || kind === "audio" || kind === "video" || kind === "pdf"
					? t("attachments.previewUnavailable")
					: t("attachments.readFailed"),
			);
		} finally {
			if (currentRequest === requestId) setLoading(false);
		}
	};

	const api: AttachmentPreviewApi = {
		selection,
		open: (attachment, relativePath) => load(attachment, relativePath),
		close,
	};
	const kind = createMemo(() => {
		const current = selection();
		return current ? previewKind(current) : "unknown";
	});
	const canDownload = createMemo(() => {
		const current = selection();
		return Boolean(current && (!isCollection(current.attachment) || current.relativePath));
	});
	const showMetadata = createMemo(() => {
		const current = selection();
		return Boolean(
			current &&
				kind() === "unknown" &&
				(!isCollection(current.attachment) || current.relativePath),
		);
	});

	const download = async (): Promise<void> => {
		const current = selection();
		if (!current || !canDownload()) return;
		setDownloading(true);
		setActionError(undefined);
		try {
			const url = await store.attachments.url({
				conversationId: current.conversationId,
				attachmentId: current.attachment.id,
				...(current.relativePath ? { relativePath: current.relativePath } : {}),
				operation: "download",
			});
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = selectedName(current);
			anchor.click();
			if (url.startsWith("blob:")) queueMicrotask(() => releaseObjectUrl(url));
		} catch {
			setActionError(t("attachments.downloadFailed"));
		} finally {
			setDownloading(false);
		}
	};

	return (
		<AttachmentPreviewContext.Provider value={api}>
			{props.children}
			<Show when={selection()} keyed>
				{(current) => (
					<aside
						class="attachment-preview-column"
						aria-label={t("attachments.previewLabel")}
						aria-busy={loading()}
					>
						<header>
							<strong>{selectedName(current)}</strong>
							<Button type="button" onClick={api.close} aria-label={t("attachments.close")}>
								{t("attachments.close")}
							</Button>
						</header>
						<div class="attachment-preview-body">
							<Show when={loading()}>
								<p class="attachment-preview-status" role="status">
									{t("attachments.loading")}
								</p>
							</Show>
							<Show when={actionError()}>
								{(error) => (
									<p class="attachment-preview-error" role="alert">
										{error()}
									</p>
								)}
							</Show>
							<Show when={preview().error}>
								<p class="attachment-preview-error" role="alert">
									{t("attachments.readFailed")}
								</p>
							</Show>
							<Show when={preview().content !== undefined}>
								<pre class="attachment-preview-text">{preview().content}</pre>
							</Show>
							<Show when={previewUrl()} keyed>
								{(url) => (
									<div class="attachment-preview-media">
										<Show when={kind() === "image"}>
											<img
												src={url}
												alt={t("attachments.imagePreview", { name: selectedName(current) })}
												draggable={false}
											/>
										</Show>
										<Show when={kind() === "audio"}>
											{/* biome-ignore lint/a11y/useMediaCaption: arbitrary user audio has no trusted caption asset */}
											<audio
												src={url}
												controls
												aria-label={t("attachments.audioPreview", { name: selectedName(current) })}
											/>
										</Show>
										<Show when={kind() === "video"}>
											{/* biome-ignore lint/a11y/useMediaCaption: arbitrary user video has no trusted caption asset */}
											<video
												src={url}
												controls
												aria-label={t("attachments.videoPreview", { name: selectedName(current) })}
											/>
										</Show>
										<Show when={kind() === "pdf"}>
											<object
												data={url}
												type="application/pdf"
												aria-label={t("attachments.pdfPreview", { name: selectedName(current) })}
											>
												<p>{t("attachments.pdfFallback")}</p>
											</object>
										</Show>
									</div>
								)}
							</Show>
							<Show when={rootFiles() !== undefined}>
								<ul class="attachment-preview-files" aria-label={t("attachments.treeLabel")}>
									<For each={rootFiles()}>
										{(file) => (
											<li data-entry-kind={file.entryKind}>
												<Button
													type="button"
													disabled={file.entryKind !== "file"}
													aria-current={
														current.relativePath === file.relativePath ? "true" : undefined
													}
													onClick={() => void load(current.attachment, file.relativePath, file)}
												>
													<span>{file.relativePath}</span>
													<small>
														{t(`attachments.entryKinds.${file.entryKind}`)}
														{file.bytes === undefined
															? ""
															: ` · ${t("attachments.byteCount", { count: file.bytes })}`}
													</small>
												</Button>
											</li>
										)}
									</For>
								</ul>
							</Show>
							<Show when={showMetadata()}>
								<dl class="attachment-preview-metadata" aria-label={t("attachments.metadataLabel")}>
									<div>
										<dt>{t("attachments.nameLabel")}</dt>
										<dd>{selectedName(current)}</dd>
									</div>
									<div>
										<dt>{t("attachments.typeLabel")}</dt>
										<dd>{current.entry?.mime ?? t("attachments.unknownType")}</dd>
									</div>
									<div>
										<dt>{t("attachments.sizeLabel")}</dt>
										<dd>
											{t("attachments.byteCount", {
												count: current.entry?.bytes ?? current.attachment.bytes,
											})}
										</dd>
									</div>
								</dl>
							</Show>
						</div>
						<Show when={canDownload()}>
							<Button type="button" disabled={downloading()} onClick={() => void download()}>
								{downloading() ? t("attachments.downloading") : t("attachments.download")}
							</Button>
						</Show>
					</aside>
				)}
			</Show>
		</AttachmentPreviewContext.Provider>
	);
}

export function useAttachmentPreview(): AttachmentPreviewApi | undefined {
	return useContext(AttachmentPreviewContext);
}
