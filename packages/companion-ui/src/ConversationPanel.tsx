import { i18n, useTranslation } from "@bear-harness/i18n";
import type { CharacterMedia, PiTimelineEntry } from "@bear-harness/protocol";
import { createMemo, createSignal, For, Show } from "solid-js";
import { followTimelineScroll } from "./lib/dom-effects.js";
import { useCompanionStore } from "./stores/companion.js";
import { useConversationViewWorkflow } from "./stores/conversation-workflows.js";
import { ThreadHead } from "./ThreadHead.js";
import { Button, TextField } from "./ui/primitives.js";
import { WorkTimelineItem } from "./WorkPanel.js";

/** ConversationPanel renders the active Pi timeline plus transient stream state. */

function PiTimelineEntryView(props: {
	entry: PiTimelineEntry;
	onPreviewMedia(media: CharacterMedia): void;
}) {
	const store = useCompanionStore();
	const [t] = useTranslation(undefined, { i18n });
	const [editing, setEditing] = createSignal(false);
	const [editText, setEditText] = createSignal("");
	const [correcting, setCorrecting] = createSignal(false);
	const [operationsOpen, setOperationsOpen] = createSignal(false);
	const [correctionDetail, setCorrectionDetail] = createSignal("");
	const entry = props.entry;
	if (entry.kind !== "message") {
		// Native Pi context entries describe internal session bookkeeping. Rendering
		// each one as an unlabeled rule made model/level changes look like broken UI.
		return null;
	}
	if (entry.role === "tool") {
		const media =
			entry.toolName === "host_media" && entry.mediaId
				? store.character?.media.find((item) => item.id === entry.mediaId)
				: undefined;
		if (media)
			return <MediaTimelineCard media={media} onOpen={() => props.onPreviewMedia(media)} />;
		if (entry.toolName === "host_choices" && entry.choices)
			return (
				<section class="message-choices" aria-label={entry.choices.prompt}>
					<strong>{entry.choices.prompt}</strong>
					<div class="message-choice-list">
						<For each={entry.choices.items}>
							{(choice) => (
								<Button
									type="button"
									class="message-choice"
									onClick={() => void store.sendMessage(choice.message)}
								>
									{choice.label}
								</Button>
							)}
						</For>
					</div>
				</section>
			);
		const label = (() => {
			switch (entry.toolName) {
				case "role_skill":
					return t("messages.toolActivity.read");
				case "host_state":
					return t("messages.toolActivity.state");
				case "host_media":
				case "host_choices":
					return t("messages.toolActivity.generic");
				case "host_delegate":
					return t("messages.toolActivity.delegate");
				case "host_canon":
					return t("messages.toolActivity.canon");
				case "tdai_memory_search":
					return t("messages.toolActivity.memorySearch");
				case "tdai_conversation_search":
					return t("messages.toolActivity.conversationSearch");
				case "explicit_memory":
					return t("messages.toolActivity.explicitMemory");
				default:
					return t("messages.toolActivity.generic");
			}
		})();
		return (
			<article
				class="msg pi-tool-result"
				data-pi-entry-id={entry.id}
				aria-label={`${label} ${entry.status}`}
			>
				<div class="msg-meta">
					<span>{label}</span>
				</div>
				<span class="pi-tool-status">
					{t(
						entry.status === "succeeded"
							? "messages.toolActivity.completed"
							: "messages.toolActivity.failed",
					)}
				</span>
			</article>
		);
	}
	const isUser = entry.role === "user";
	const characterName = store.character?.name ?? "";
	const assistant = entry.role === "assistant" ? entry : undefined;
	const version = assistant?.version;
	const failed = assistant?.stopReason === "error" || assistant?.stopReason === "aborted";
	const errorText =
		assistant?.stopReason === "aborted"
			? t("messages.responseStopped")
			: assistant?.errorMessage
				? t("messages.responseFailedSaved")
				: undefined;
	if (!isUser && (entry.text === undefined || entry.text.length === 0) && !failed) {
		return null;
	}
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
					<span class="agent-message-name">{characterName}</span>
				</Show>
				<article
					class={`msg pi-timeline-message ${isUser ? "user" : "bear-msg"}${failed ? " stream-failed" : ""}`}
					data-testid="timeline-message"
					data-pi-entry-id={entry.id}
					aria-label={isUser ? t("messages.you") : characterName}
				>
					<div class="msg-heading">
						<Show when={isUser}>
							<div class="msg-meta">{t("messages.you")}</div>
						</Show>
						<Button
							type="button"
							class="msg-menu-trigger"
							aria-label={t("messages.operations")}
							aria-expanded={operationsOpen()}
							onClick={() => setOperationsOpen((open) => !open)}
						>
							<span aria-hidden="true">•••</span>
						</Button>
					</div>
					<Show when={entry.text !== undefined && entry.text.length > 0}>
						<p>{entry.text}</p>
					</Show>
					<Show when={failed && errorText !== undefined && errorText.length > 0}>
						<span class="stream-error" role="alert">
							{errorText}
						</span>
					</Show>
					<Show when={editing() && isUser}>
						<div class="message-inline-editor">
							<TextField>
								<TextField.TextArea
									value={editText()}
									onInput={(event) => setEditText(event.currentTarget.value)}
									aria-label={t("messages.editLabel")}
								/>
							</TextField>
							<p class="edit-branch-note">{t("messages.userEditBranchNote")}</p>
							<Button
								type="button"
								disabled={!editText().trim()}
								onClick={() => {
									void store.editMessage(entry.id, editText().trim());
									setEditing(false);
								}}
							>
								{t("messages.save")}
							</Button>
							<Button type="button" onClick={() => setEditing(false)}>
								{t("messages.cancel")}
							</Button>
						</div>
					</Show>
					<Show when={correcting() && !isUser}>
						<div class="message-correction-panel">
							<strong>{store.character?.character.correction.reason_group_label}</strong>
							<div class="message-correction-presets">
								<For each={store.character?.character.correction.presets ?? []}>
									{(preset) => (
										<Button
											type="button"
											onClick={() => {
												const detail = correctionDetail().trim();
												void store.regenerateMessage(
													entry.id,
													detail ? `${preset.label}：${detail}` : preset.label,
												);
												setCorrecting(false);
											}}
										>
											{preset.label}
										</Button>
									)}
								</For>
							</div>
							<TextField>
								<TextField.TextArea
									value={correctionDetail()}
									onInput={(event) => setCorrectionDetail(event.currentTarget.value)}
									placeholder={store.character?.character.correction.custom_placeholder}
									aria-label={store.character?.character.correction.custom_label}
								/>
							</TextField>
							<Button
								type="button"
								disabled={!correctionDetail().trim()}
								onClick={() => {
									void store.regenerateMessage(entry.id, correctionDetail().trim());
									setCorrecting(false);
								}}
							>
								{store.character?.character.correction.custom_label}
							</Button>
							<Button type="button" onClick={() => setCorrecting(false)}>
								{t("messages.cancel")}
							</Button>
						</div>
					</Show>
					<fieldset class="message-operations" classList={{ "is-open": operationsOpen() }}>
						<legend>{t("messages.operations")}</legend>
						<Show when={isUser}>
							<Button
								type="button"
								onClick={() => {
									setEditText(entry.text ?? "");
									setEditing(true);
								}}
							>
								{t("messages.edit")}
							</Button>
						</Show>
						<Show when={!isUser}>
							<Button type="button" onClick={() => void store.regenerateMessage(entry.id)}>
								{t("messages.regenerate")}
							</Button>
							<Button type="button" onClick={() => setCorrecting(true)}>
								{store.character?.character.correction.trigger_label}
							</Button>
						</Show>
						<Button
							type="button"
							onClick={() => {
								setOperationsOpen(false);
								void store.sendMessage(t("messages.rememberMoment"));
							}}
						>
							{t("messages.rememberMoment")}
						</Button>
						<Button type="button" onClick={() => void store.createConversationFromEntry(entry.id)}>
							{t("messages.branch")}
						</Button>
						<Button
							type="button"
							class="message-operations-dismiss"
							onClick={() => setOperationsOpen(false)}
						>
							{t("messages.cancel")}
						</Button>
					</fieldset>
				</article>
				<Show when={!isUser && version}>
					{(pager) => (
						<nav class="message-version-pager" aria-label={t("messages.versionPager")}>
							<Button
								type="button"
								aria-label={t("messages.previousVersion")}
								disabled={pager().current === 0}
								onClick={() =>
									void store.switchMessageVersion(pager().leafIds[pager().current - 1]!)
								}
							>
								‹
							</Button>
							<span>{`${pager().current + 1} / ${pager().leafIds.length}`}</span>
							<Button
								type="button"
								aria-label={t("messages.nextVersion")}
								disabled={pager().current === pager().leafIds.length - 1}
								onClick={() =>
									void store.switchMessageVersion(pager().leafIds[pager().current + 1]!)
								}
							>
								›
							</Button>
						</nav>
					)}
				</Show>
			</div>
		</div>
	);
}

function PiTimelineRenderer(props: {
	entries: readonly PiTimelineEntry[];
	onPreviewMedia(media: CharacterMedia): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const visible = createMemo(() => {
		const result: Array<PiTimelineEntry | PiTimelineEntry[]> = [];
		let lastAssistantSignature: string | undefined;
		for (const entry of props.entries) {
			if (entry.kind !== "message") continue;
			if (
				entry.role === "tool" &&
				entry.status === "succeeded" &&
				!entry.mediaId &&
				!entry.choices
			) {
				lastAssistantSignature = undefined;
				const previous = result.at(-1);
				if (Array.isArray(previous)) previous.push(entry);
				else result.push([entry]);
				continue;
			}
			if (entry.role === "user") {
				lastAssistantSignature = undefined;
				result.push(entry);
				continue;
			}
			if (entry.role !== "assistant") {
				result.push(entry);
				continue;
			}
			const signature = JSON.stringify({
				text: entry.text ?? "",
				stopReason: entry.stopReason,
				errorMessage: entry.errorMessage ?? "",
			});
			if (signature === lastAssistantSignature) continue;
			lastAssistantSignature = signature;
			result.push(entry);
		}
		return result;
	});
	return (
		<For each={visible()}>
			{(item) => {
				const entries = Array.isArray(item) ? item : [item];
				const first = entries[0];
				if (!first) return null;
				return (
					<>
						<Show
							when={entries.length > 1}
							fallback={<PiTimelineEntryView entry={first} onPreviewMedia={props.onPreviewMedia} />}
						>
							<details class="tool-activity-group">
								<summary>
									<span>{t("messages.toolActivity.generic")}</span>
									<span>
										{entries.length} · {t("messages.toolActivity.completed")}
									</span>
								</summary>
								<div class="tool-activity-details">
									<For each={entries}>
										{(entry) => (
											<PiTimelineEntryView entry={entry} onPreviewMedia={props.onPreviewMedia} />
										)}
									</For>
								</div>
							</details>
						</Show>
						<For each={entries}>{(entry) => <WorkTimelineItem messageId={entry.id} />}</For>
					</>
				);
			}}
		</For>
	);
}

/**
 * Partial assistant content from the Pi live state. Rendered until the
 * assistant `message_end` persists a native timeline entry, at which point the
 * projection naturally switches to the durable timeline (plan §5.2: no local
 * dedupe, text merge, or snapshot patch). A final `error`/`aborted` message is
 * kept visible with its Pi-provided error text.
 */
function PiLiveAssistantMessageView() {
	const store = useCompanionStore();
	const [t] = useTranslation(undefined, { i18n });
	const characterName = store.character?.name ?? "";
	return (
		<Show
			when={
				store.activePiLiveState?.streamingMessage ??
				(store.activePiLiveState?.isStreaming ? { stopReason: "pending" as const } : undefined)
			}
		>
			{(live) => {
				const message = live();
				const stopReason = message.stopReason;
				const failed = stopReason === "error" || stopReason === "aborted";
				const errorText =
					stopReason === "aborted"
						? t("messages.responseStopped")
						: message.errorMessage
							? t("messages.responseFailedSaved")
							: undefined;
				return (
					<div class="timeline-entry-row">
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
							<span class="agent-message-name">{characterName}</span>
							<article
								class={`msg bear-msg streaming-message${failed ? " stream-failed" : ""}`}
								aria-label={characterName}
							>
								<Show when={message.text !== undefined && message.text.length > 0}>
									<p>{message.text}</p>
								</Show>
								<Show when={store.activePiLiveState?.isStreaming === true}>
									<span
										class="streaming-status"
										role="status"
										aria-label={t("messages.responding")}
									/>
								</Show>
								<Show when={failed && errorText !== undefined && errorText.length > 0}>
									<span class="stream-error" role="alert">
										{errorText}
									</span>
								</Show>
							</article>
						</div>
					</div>
				);
			}}
		</Show>
	);
}

function PiQueuedUserMessages() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	return (
		<For each={store.activePiLiveState?.queuedUserMessages ?? []}>
			{(message) => (
				<div class="timeline-entry-row" data-testid="pi-queued-user-message">
					<div class="user-message-column">
						<article class="msg pi-timeline-message user" aria-label={t("messages.you")}>
							<div class="msg-meta">{t("messages.you")}</div>
							<p>{message}</p>
							<span class="streaming-status" role="status" aria-label={t("messages.queued")} />
						</article>
					</div>
				</div>
			)}
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
		() =>
			`${store.activePiTimeline?.entries.length ?? 0}:${store.activePiLiveState?.streamingMessage?.text?.length ?? 0}:${store.activePiLiveState?.queuedUserMessages.length ?? 0}`,
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
					<Show when={store.activePiTimeline}>
						{(timeline) => (
							<PiTimelineRenderer
								entries={timeline().entries}
								onPreviewMedia={props.onPreviewMedia}
							/>
						)}
					</Show>
					<PiQueuedUserMessages />
					<PiLiveAssistantMessageView />
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
