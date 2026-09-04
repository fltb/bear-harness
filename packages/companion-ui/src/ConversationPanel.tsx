import { i18n, useTranslation } from "@bear-harness/i18n";
import type { CharacterMedia, PiSessionEntry } from "@bear-harness/protocol";
import { faCodeBranch, faCopy, faPen, faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { Icon } from "./Icon.js";
import { followTimelineScroll } from "./lib/dom-effects.js";
import { MessageContent } from "./MessageContent.js";
import { type TimelineProjectionItem, useCompanionStore } from "./stores/companion.js";
import { useConversationViewWorkflow } from "./stores/conversation-workflows.js";
import { ThreadHead } from "./ThreadHead.js";
import { Button, TextField } from "./ui/primitives.js";
import { WorkTimelineItem } from "./WorkPanel.js";

/** ConversationPanel renders the active Pi timeline plus transient stream state. */

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
				? [String(part.text)]
				: [],
		)
		.join("\n");
}

function hostToolPayload(details: unknown): Record<string, unknown> | undefined {
	if (!details || typeof details !== "object" || !("ok" in details) || details.ok !== true) return;
	if (!("data" in details) || !details.data || typeof details.data !== "object") return;
	return details.data as Record<string, unknown>;
}

function hostChoices(payload: Record<string, unknown> | undefined) {
	if (!payload || typeof payload.prompt !== "string" || !Array.isArray(payload.items)) return;
	const items = payload.items.filter((item): item is { label: string; message: string } =>
		Boolean(
			item &&
				typeof item === "object" &&
				"label" in item &&
				typeof item.label === "string" &&
				"message" in item &&
				typeof item.message === "string",
		),
	);
	return items.length ? { prompt: payload.prompt, items } : undefined;
}

function toolActivityKey(toolName: string) {
	switch (toolName) {
		case "role_skill":
			return "messages.toolActivity.read" as const;
		case "host_state":
			return "messages.toolActivity.state" as const;
		case "host_media":
		case "host_choices":
			return "messages.toolActivity.generic" as const;
		case "host_delegate":
			return "messages.toolActivity.delegate" as const;
		case "host_canon":
			return "messages.toolActivity.canon" as const;
		case "tdai_memory_search":
			return "messages.toolActivity.memorySearch" as const;
		case "tdai_conversation_search":
			return "messages.toolActivity.conversationSearch" as const;
		case "explicit_memory":
			return "messages.toolActivity.explicitMemory" as const;
		default:
			return "messages.toolActivity.generic" as const;
	}
}

function PiTimelineEntryView(props: {
	entry: PiSessionEntry;
	onPreviewMedia(media: CharacterMedia): void;
	canEdit: boolean;
	canRegenerate: boolean;
}) {
	const store = useCompanionStore();
	const [t] = useTranslation(undefined, { i18n });
	const [editing, setEditing] = createSignal(false);
	const [editText, setEditText] = createSignal("");
	const [correcting, setCorrecting] = createSignal(false);
	const [correctionDetail, setCorrectionDetail] = createSignal("");
	const [actionBusy, setActionBusy] = createSignal(false);
	const [actionError, setActionError] = createSignal<string | null>(null);
	const [copied, setCopied] = createSignal(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => {
		if (copiedTimer !== undefined) clearTimeout(copiedTimer);
	});
	const entry = props.entry;
	if (entry.type !== "message") {
		// Native Pi context entries describe internal session bookkeeping. Rendering
		// each one as an unlabeled rule made model/level changes look like broken UI.
		return null;
	}
	const message = entry.message;
	if (message.role === "toolResult") {
		const toolPayload = hostToolPayload(message.details);
		if (message.toolName === "explicit_memory" && toolPayload?.changed === false) return null;
		const mediaId =
			message.toolName === "host_media" && typeof toolPayload?.mediaId === "string"
				? toolPayload.mediaId
				: undefined;
		const choices = message.toolName === "host_choices" ? hostChoices(toolPayload) : undefined;
		const media =
			message.toolName === "host_media" && mediaId
				? store.character?.media.find((item) => item.id === mediaId)
				: undefined;
		if (media)
			return <MediaTimelineCard media={media} onOpen={() => props.onPreviewMedia(media)} />;
		if (message.toolName === "host_choices" && choices)
			return (
				<section class="message-choices" aria-label={choices.prompt}>
					<strong>{choices.prompt}</strong>
					<div class="message-choice-list">
						<For each={choices.items}>
							{(choice) => (
								<Button
									type="button"
									class="message-choice"
									disabled={store.pendingUserMessages.length > 0}
									onClick={() => void store.sendMessage(choice.message)}
								>
									{choice.label}
								</Button>
							)}
						</For>
					</div>
				</section>
			);
		const label = t(toolActivityKey(message.toolName));
		return (
			<article
				class="msg pi-tool-result"
				data-pi-entry-id={entry.id}
				aria-label={`${label} ${message.isError ? "failed" : "succeeded"}`}
			>
				<div class="msg-meta">
					<span>{label}</span>
				</div>
				<span class="pi-tool-status">
					{t(!message.isError ? "messages.toolActivity.completed" : "messages.toolActivity.failed")}
				</span>
			</article>
		);
	}
	const isUser = message.role === "user";
	const characterName = () => store.character?.name ?? "";
	const currentMessage = () => {
		const current = props.entry;
		return current.type === "message" ? current.message : message;
	};
	const assistant = () => {
		const current = currentMessage();
		return current.role === "assistant" ? current : undefined;
	};
	const text = () => {
		const current = currentMessage();
		return "content" in current ? messageText(current.content) : "";
	};
	const failed = () => assistant()?.stopReason === "error" || assistant()?.stopReason === "aborted";
	const errorText = () =>
		assistant()?.stopReason === "aborted"
			? t("messages.responseStopped")
			: assistant()?.errorMessage
				? t("messages.responseFailedSaved")
				: undefined;
	if (!isUser && text().length === 0 && !failed()) {
		return null;
	}
	const runAction = async (action: () => Promise<void>) => {
		setActionBusy(true);
		setActionError(null);
		try {
			await action();
		} catch (cause) {
			setActionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setActionBusy(false);
		}
	};
	const commitEdit = async () => {
		const value = editText().trim();
		if (!value || value === text()) {
			setEditing(false);
			return;
		}
		await runAction(() => store.editMessage(entry.id, value));
		if (!actionError()) setEditing(false);
	};
	const submitCorrection = async (feedback: string) => {
		const value = feedback.trim();
		if (!value) return;
		await runAction(() => store.regenerateMessage(entry.id, value));
		setCorrectionDetail("");
		setCorrecting(false);
	};
	const copyMessage = async () => {
		if (typeof navigator === "undefined" || !navigator.clipboard) return;
		await navigator.clipboard.writeText(text());
		setCopied(true);
		if (copiedTimer !== undefined) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => {
			copiedTimer = undefined;
			setCopied(false);
		}, 1_500);
	};
	return (
		<div class="timeline-entry-row" data-testid="timeline-entry-row">
			<Show when={!isUser && store.character !== undefined}>
				<img
					class="agent-message-avatar"
					src={store.character?.visual.avatarUrl}
					alt=""
					aria-hidden="true"
					draggable={false}
				/>
			</Show>
			<div class={isUser ? "user-message-column" : "agent-message-column"}>
				<Show when={!isUser}>
					<span class="agent-message-name">{characterName()}</span>
				</Show>
				<article
					class={`msg pi-timeline-message ${isUser ? "user" : "bear-msg"}${failed() ? " stream-failed" : ""}`}
					data-testid="timeline-message"
					data-pi-entry-id={entry.id}
					aria-label={isUser ? t("messages.you") : characterName()}
				>
					<div class="msg-heading">
						<Show when={isUser}>
							<div class="msg-meta">{t("messages.you")}</div>
						</Show>
						<div class="message-direct-actions">
							<Show when={props.canEdit && isUser}>
								<Button
									type="button"
									class="msg-inline-action"
									aria-label={t("messages.edit")}
									title={t("messages.edit")}
									onClick={() => {
										setEditText(text());
										setEditing(true);
									}}
								>
									<Icon icon={faPen} />
								</Button>
							</Show>
							<Button
								type="button"
								class="msg-inline-action"
								aria-label={copied() ? t("messages.copied") : t("messages.copy")}
								title={copied() ? t("messages.copied") : t("messages.copy")}
								onClick={() => void copyMessage()}
							>
								<Icon icon={faCopy} />
							</Button>
						</div>
					</div>
					<Show when={text().length > 0 && !editing()}>
						<MessageContent text={text()} format={isUser ? "plain" : "markdown"} />
					</Show>
					<Show when={editing() && isUser}>
						<TextField class="message-inline-editor">
							<TextField.TextArea
								autofocus
								value={editText()}
								onInput={(event) => setEditText(event.currentTarget.value)}
								onBlur={() => void commitEdit()}
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										event.preventDefault();
										setEditing(false);
									}
									if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
										event.preventDefault();
										void commitEdit();
									}
								}}
								aria-label={t("messages.editLabel")}
							/>
						</TextField>
					</Show>
					<Show when={failed() && (errorText()?.length ?? 0) > 0}>
						<span class="stream-error" role="alert">
							{errorText()}
						</span>
					</Show>
					<Show when={props.canRegenerate && !isUser}>
						<div class="message-primary-actions">
							<Button
								type="button"
								disabled={actionBusy()}
								onClick={() => void runAction(() => store.regenerateMessage(entry.id))}
							>
								<Icon icon={faRotateRight} />
								{t("messages.regenerate")}
							</Button>
							<Button type="button" disabled={actionBusy()} onClick={() => setCorrecting(true)}>
								{store.character?.character.correction.trigger_label}
							</Button>
							<Button
								type="button"
								disabled={actionBusy()}
								onClick={() => void runAction(() => store.createConversationFromEntry(entry.id))}
							>
								<Icon icon={faCodeBranch} />
								{t("messages.branch")}
							</Button>
						</div>
					</Show>
					<Show when={correcting() && props.canRegenerate && !isUser}>
						<Button
							type="button"
							class="correction-popover-backdrop"
							aria-label={t("messages.cancel")}
							onClick={() => setCorrecting(false)}
						/>
						<div class="message-correction-popover" role="menu">
							<div class="message-correction-presets">
								<For each={store.character?.character.correction.presets ?? []}>
									{(preset) => (
										<Button
											type="button"
											role="menuitem"
											onClick={() => void submitCorrection(preset.label)}
										>
											{preset.label}
										</Button>
									)}
								</For>
							</div>
							<form
								class="message-correction-custom"
								onSubmit={(event) => {
									event.preventDefault();
									void submitCorrection(correctionDetail());
								}}
							>
								<TextField>
									<TextField.Input
										value={correctionDetail()}
										onInput={(event) => setCorrectionDetail(event.currentTarget.value)}
										placeholder={store.character?.character.correction.custom_placeholder}
										aria-label={store.character?.character.correction.custom_label}
									/>
								</TextField>
								<Button type="submit" disabled={!correctionDetail().trim() || actionBusy()}>
									{store.character?.character.correction.custom_label}
								</Button>
							</form>
						</div>
					</Show>
					<Show when={actionError()}>
						{(error) => (
							<span class="stream-error" role="alert">
								{error()}
							</span>
						)}
					</Show>
				</article>
			</div>
		</div>
	);
}

function OptimisticUserProjection(props: {
	item: Extract<TimelineProjectionItem, { kind: "optimistic-user" }>;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const message = () => props.item.message;
	return (
		<div class="timeline-entry-row" data-testid="pending-user-message">
			<div class="user-message-column">
				<article
					class={`msg pi-timeline-message user${message().state === "failed" ? " stream-failed" : ""}`}
				>
					<div class="msg-meta">{t("messages.you")}</div>
					<MessageContent text={message().text} format="plain" />
					<Show
						when={message().state === "failed"}
						fallback={
							<span class="message-send-status" role="status">
								<span class="streaming-status" aria-hidden="true" />
								<span>{t("messages.sending")}</span>
							</span>
						}
					>
						<span class="stream-error" role="alert">
							{t("messages.sendFailed")}
						</span>
						<div class="message-inline-actions">
							<Button
								type="button"
								onClick={() => void store.retryPendingMessage(message().clientMessageId)}
							>
								{t("messages.retry")}
							</Button>
							<Button
								type="button"
								onClick={() => store.dismissPendingMessage(message().clientMessageId)}
							>
								{t("messages.discard")}
							</Button>
						</div>
					</Show>
				</article>
			</div>
		</div>
	);
}

function QueuedUserProjection(props: { text: string }) {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<div class="timeline-entry-row" data-testid="pi-queued-user-message">
			<div class="user-message-column">
				<article class="msg pi-timeline-message user" aria-label={t("messages.you")}>
					<div class="msg-meta">{t("messages.you")}</div>
					<MessageContent text={props.text} format="plain" />
					<span class="message-send-status" role="status">
						<span class="streaming-status" aria-hidden="true" />
						<span>{t("messages.queued")}</span>
					</span>
				</article>
			</div>
		</div>
	);
}

function ToolExecutionProjection(props: {
	item: Extract<TimelineProjectionItem, { kind: "tool-execution" }>;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const label = () => t(toolActivityKey(props.item.toolName));
	const status = () =>
		props.item.status === "running"
			? t("messages.toolActivity.running")
			: props.item.status === "completed"
				? t("messages.toolActivity.completed")
				: t("messages.toolActivity.failed");
	return (
		<article
			class="msg pi-tool-result"
			aria-label={`${label()} ${status()}`}
			data-status={props.item.status}
			data-tool-call-id={props.item.toolCallId}
		>
			<div class="msg-meta">
				<span>{label()}</span>
			</div>
			<span class="pi-tool-status" role="status">
				<Show when={props.item.status === "running"}>
					<span class="streaming-status" aria-hidden="true" />
				</Show>
				{status()}
			</span>
		</article>
	);
}

function StreamingAssistantProjection(props: {
	item: Extract<TimelineProjectionItem, { kind: "streaming-assistant" }>;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const message = () => props.item.message;
	const text = () => ("content" in message() ? messageText(message().content) : "");
	const failed = () => message().stopReason === "error" || message().stopReason === "aborted";
	const errorText = () =>
		message().stopReason === "aborted"
			? t("messages.responseStopped")
			: message().errorMessage
				? t("messages.responseFailedSaved")
				: undefined;
	const characterName = () => store.character?.name ?? "";
	return (
		<div class="timeline-entry-row" data-testid="streaming-assistant-message">
			<Show when={store.character !== undefined}>
				<img
					class="agent-message-avatar"
					src={store.character?.visual.avatarUrl}
					alt=""
					aria-hidden="true"
					draggable={false}
				/>
			</Show>
			<div class="agent-message-column">
				<span class="agent-message-name">{characterName()}</span>
				<article
					class={`msg bear-msg streaming-message${failed() ? " stream-failed" : ""}`}
					aria-label={characterName()}
				>
					<MessageContent
						text={text()}
						format="markdown"
						streaming={store.activePiLiveState?.isStreaming === true}
					/>
					<Show when={store.activePiLiveState?.isStreaming === true}>
						<span class="streaming-status" role="status" aria-label={t("messages.responding")} />
					</Show>
					<Show when={failed() && errorText()}>
						{(error) => (
							<span class="stream-error" role="alert">
								{error()}
							</span>
						)}
					</Show>
				</article>
			</div>
		</div>
	);
}

function PiTimelineRenderer(props: {
	items: readonly TimelineProjectionItem[];
	onPreviewMedia(media: CharacterMedia): void;
}) {
	const store = useCompanionStore();
	const turnActive = () => store.activePiLiveState?.isStreaming === true;
	const latestUserId = createMemo(
		() =>
			[...props.items]
				.reverse()
				.find(
					(item) =>
						item.kind === "entry" &&
						item.entry.type === "message" &&
						item.entry.message.role === "user",
				)?.id,
	);
	const latestAssistantId = createMemo(
		() =>
			[...props.items]
				.reverse()
				.find(
					(item) =>
						item.kind === "entry" &&
						item.entry.type === "message" &&
						item.entry.message.role === "assistant",
				)?.id,
	);
	const itemIds = createMemo(() => props.items.map((item) => item.id));
	return (
		<For each={itemIds()}>
			{(itemId) => {
				const item = () => props.items.find((candidate) => candidate.id === itemId);
				const entryItem = () => {
					const value = item();
					return value?.kind === "entry" ? value : undefined;
				};
				const optimisticItem = () => {
					const value = item();
					return value?.kind === "optimistic-user" ? value : undefined;
				};
				const queuedItem = () => {
					const value = item();
					return value?.kind === "queued-user" ? value : undefined;
				};
				const toolExecutionItem = () => {
					const value = item();
					return value?.kind === "tool-execution" ? value : undefined;
				};
				const streamingItem = () => {
					const value = item();
					return value?.kind === "streaming-assistant" ? value : undefined;
				};
				return (
					<Switch>
						<Match when={entryItem()}>
							{(entryItem) => (
								<>
									<PiTimelineEntryView
										entry={entryItem().entry}
										onPreviewMedia={props.onPreviewMedia}
										canEdit={!turnActive() && entryItem().id === latestUserId()}
										canRegenerate={!turnActive() && entryItem().id === latestAssistantId()}
									/>
									<WorkTimelineItem messageId={entryItem().id} />
								</>
							)}
						</Match>
						<Match when={optimisticItem()}>
							{(optimistic) => <OptimisticUserProjection item={optimistic()} />}
						</Match>
						<Match when={queuedItem()}>
							{(queued) => <QueuedUserProjection text={queued().text} />}
						</Match>
						<Match when={toolExecutionItem()}>
							{(execution) => <ToolExecutionProjection item={execution()} />}
						</Match>
						<Match when={streamingItem()}>
							{(streaming) => <StreamingAssistantProjection item={streaming()} />}
						</Match>
					</Switch>
				);
			}}
		</For>
	);
}

export function ConversationPanel(props: { onPreviewMedia(media: CharacterMedia): void }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const view = useConversationViewWorkflow(store);
	const { sceneLabel, hasThreadContent } = view;
	let threadRef: HTMLElement | undefined;

	followTimelineScroll(
		() => threadRef,
		() => store.activeTimeline.map((item) => item.id).join(":"),
	);

	return (
		<>
			<ThreadHead sceneLabel={sceneLabel()} />
			<section
				class="thread"
				aria-live="polite"
				aria-label={t("messages.conversation")}
				ref={(el) => {
					threadRef = el;
				}}
			>
				<Show when={store.error != null}>
					<div class="thread-error" role="alert">
						{store.error}
					</div>
				</Show>

				<Show when={hasThreadContent()}>
					<PiTimelineRenderer items={store.activeTimeline} onPreviewMedia={props.onPreviewMedia} />
				</Show>
			</section>
		</>
	);
}

function MediaTimelineCard(props: { media: CharacterMedia; onOpen(): void }) {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<section class="message-media-card" aria-label={props.media.label}>
			<div>
				<strong>{props.media.label}</strong>
				<p>{props.media.description}</p>
			</div>
			<Button type="button" onClick={props.onOpen}>
				{t("messages.openMedia")}
			</Button>
		</section>
	);
}

function CharacterMediaContent(props: { media: CharacterMedia }) {
	if (props.media.kind === "audio")
		return (
			<audio controls loop={props.media.loop} src={props.media.url} aria-label={props.media.label}>
				<track kind="captions" src={props.media.captionsUrl} srclang="und" default />
			</audio>
		);
	if (props.media.kind === "video")
		return (
			<video
				controls
				loop={props.media.loop}
				poster={props.media.posterUrl}
				src={props.media.url}
				aria-label={props.media.label}
			>
				<track kind="captions" src={props.media.captionsUrl} srclang="und" default />
			</video>
		);
	const source =
		props.media.kind === "animation" &&
		props.media.posterUrl &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
			? props.media.posterUrl
			: props.media.url;
	return <img src={source} alt={props.media.label} />;
}

export function MediaPreview(props: { media: CharacterMedia; onClose(): void }) {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<>
			<Button
				type="button"
				class="artifact-preview-backdrop"
				aria-label={t("messages.closeMedia")}
				onClick={props.onClose}
			/>
			<aside class="attachment-preview-column media-preview-column" aria-label={props.media.label}>
				<header>
					<div class="attachment-preview-heading">
						<small>{props.media.kind}</small>
						<strong>{props.media.label}</strong>
					</div>
					<Button type="button" aria-label={t("messages.closeMedia")} onClick={props.onClose}>
						×
					</Button>
				</header>
				<section class="attachment-preview-media media-preview-content">
					<CharacterMediaContent media={props.media} />
				</section>
				<footer class="attachment-preview-actions">
					<p>{props.media.description}</p>
				</footer>
			</aside>
		</>
	);
}
