import { i18n, useTranslation } from "@bear-harness/i18n";
import type { ConversationAttachmentSummary, PiTimelineEntry } from "@bear-harness/protocol";
import { Button } from "@kobalte/core/button";
import { Dialog } from "@kobalte/core/dialog";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, For, Show } from "solid-js";
import { useAttachmentPreview } from "./features/AttachmentPreviewPanel.js";
import { followTimelineScroll } from "./lib/dom-effects.js";
import type { CharacterDisplay } from "./stores/companion.js";
import { useCompanionStore } from "./stores/companion.js";
import { useConversationViewWorkflow } from "./stores/conversation-workflows.js";
import { ThreadHead } from "./ThreadHead.js";
import { WorkTimelineItem } from "./WorkPanel.js";

/** ConversationPanel renders the active Pi timeline plus transient stream state. */

function TimelineAttachmentRows(props: { attachments?: ConversationAttachmentSummary[] }) {
	const [t] = useTranslation(undefined, { i18n });
	const preview = useAttachmentPreview();
	return (
		<Show when={(props.attachments?.length ?? 0) > 0}>
			<ul class="timeline-attachments" aria-label={t("attachments.listLabel")}>
				<For each={props.attachments}>
					{(attachment) => (
						<li
							class="timeline-attachment-row"
							data-attachment-id={attachment.id}
							data-attachment-kind={attachment.kind}
						>
							<Button type="button" onClick={() => void preview?.open(attachment)}>
								<strong>{attachment.name}</strong>
							</Button>
							<span>
								{t(`attachments.kinds.${attachment.kind}`)}
								{" · "}
								{t(
									attachment.fileCount === 1
										? "attachments.singleFile"
										: "attachments.multipleFiles",
									{ count: attachment.fileCount },
								)}
								{" · "}
								{t("attachments.byteCount", { count: attachment.bytes })}
							</span>
						</li>
					)}
				</For>
			</ul>
		</Show>
	);
}

function PiTimelineEntryView(props: { entry: PiTimelineEntry }) {
	const store = useCompanionStore();
	const [t] = useTranslation(undefined, { i18n });
	const [editing, setEditing] = createSignal(false);
	const [editText, setEditText] = createSignal("");
	const [correcting, setCorrecting] = createSignal(false);
	const [correctionDetail, setCorrectionDetail] = createSignal("");
	const entry = props.entry;
	if (entry.kind !== "message") {
		return <div class="pi-context-separator" data-pi-entry-id={entry.id} aria-hidden="true" />;
	}
	if (entry.role === "tool") {
		return (
			<article
				class="msg pi-tool-result"
				data-pi-entry-id={entry.id}
				aria-label={`${entry.toolName} ${entry.status}`}
			>
				<div class="msg-meta">
					<span>{entry.toolName}</span>
					<span class="pi-tool-call-id">{entry.toolCallId}</span>
				</div>
				<span class="pi-tool-status">{entry.status}</span>
			</article>
		);
	}
	const isUser = entry.role === "user";
	const characterName = store.character?.name ?? "";
	const assistant = entry.role === "assistant" ? entry : undefined;
	const toolCalls = assistant?.toolCalls;
	const failed = assistant?.stopReason === "error" || assistant?.stopReason === "aborted";
	return (
		<>
			<article
				class={`msg pi-timeline-message ${isUser ? "user" : "bear-msg"}${failed ? " stream-failed" : ""}`}
				data-pi-entry-id={entry.id}
				aria-label={isUser ? "user" : characterName}
			>
				<div class="msg-meta">{isUser ? "You" : characterName}</div>
				<Show when={entry.text !== undefined && entry.text.length > 0}>
					<p>{entry.text}</p>
				</Show>
				<TimelineAttachmentRows attachments={entry.attachments} />
				<Show when={toolCalls && toolCalls.length > 0}>
					<ul class="pi-tool-calls" aria-label="Tool calls">
						<For each={toolCalls}>
							{(call) => (
								<li class="pi-tool-call" data-pi-tool-call-id={call.toolCallId}>
									<span class="pi-tool-name">{call.toolName}</span>
									<span class="pi-tool-call-id">{call.toolCallId}</span>
								</li>
							)}
						</For>
					</ul>
				</Show>
				<Show
					when={
						failed && assistant?.errorMessage !== undefined && assistant.errorMessage.length > 0
					}
				>
					<span class="stream-error" role="alert">
						{assistant?.errorMessage}
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
											void store.correctMessage(entry.id, preset.id, correctionDetail());
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
								void store.correctMessage(entry.id, "custom", correctionDetail());
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
				<fieldset class="message-operations">
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
					<Button type="button" onClick={() => void store.memory.capture(entry.id)}>
						{t("messages.rememberMoment")}
					</Button>
					<Button type="button" onClick={() => void store.createConversationFromEntry(entry.id)}>
						{t("messages.branch")}
					</Button>
				</fieldset>
			</article>
			<WorkTimelineItem messageId={entry.id} />
		</>
	);
}

function PiTimelineRenderer(props: { entries: readonly PiTimelineEntry[] }) {
	return <For each={props.entries}>{(entry) => <PiTimelineEntryView entry={entry} />}</For>;
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
		<Show when={store.activePiLiveState?.streamingMessage}>
			{(live) => {
				const message = live();
				if (message === undefined) return null;
				const stopReason = message.stopReason;
				const failed = stopReason === "error" || stopReason === "aborted";
				const errorText = message.errorMessage;
				return (
					<article
						class={`msg bear-msg streaming-message${failed ? " stream-failed" : ""}`}
						aria-label={characterName}
					>
						<div class="msg-meta">{characterName}</div>
						<Show when={message.text !== undefined && message.text.length > 0}>
							<p>{message.text}</p>
						</Show>
						<Show when={store.activePiLiveState?.isStreaming === true}>
							<span class="streaming-status" role="status" aria-label={t("messages.responding")} />
						</Show>
						<Show when={failed && errorText !== undefined && errorText.length > 0}>
							<span class="stream-error" role="alert">
								{errorText}
							</span>
						</Show>
					</article>
				);
			}}
		</Show>
	);
}

export function ConversationPanel() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const view = useConversationViewWorkflow(store);
	const { sceneTitle, hasThreadContent } = view;
	let threadRef: HTMLElement | undefined;

	followTimelineScroll(
		() => threadRef,
		() => store.activePiTimeline?.entries.length ?? 0,
	);

	return (
		<>
			<ThreadHead sceneTitle={sceneTitle()} />
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
						{t("messages.operationFailedPrefix")}
						{store.error}
					</div>
				</Show>

				<Show when={hasThreadContent()}>
					<Show when={store.activePiTimeline}>
						{(timeline) => <PiTimelineRenderer entries={timeline().entries} />}
					</Show>
					<PiLiveAssistantMessageView />
				</Show>
				<RoleplayChoices />
				<RoleplayInlineMedia />
			</section>
			<RoleplayMediaOverlays />
		</>
	);
}

function RoleplayChoices() {
	const store = useCompanionStore();
	const view = useConversationViewWorkflow(store);
	const choiceSet = view.roleplayChoiceSet;
	return (
		<Show when={choiceSet()}>
			{(set) => (
				<section class="roleplay-choices" aria-label={set().prompt}>
					<strong>{set().prompt}</strong>
					<div class="roleplay-choice-list">
						<For each={set().choices}>
							{(choice) => (
								<Button
									type="button"
									class="roleplay-choice"
									onClick={() => void store.triggerRoleplayEvent(choice.event)}
								>
									<strong>{choice.label}</strong>
									<Show when={choice.description}>
										{(description) => <span>{description()}</span>}
									</Show>
								</Button>
							)}
						</For>
					</div>
				</section>
			)}
		</Show>
	);
}

function RoleplayInlineMedia() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const media = useConversationViewWorkflow(store).roleplayInlineMedia;
	return (
		<Show when={media()}>
			{(item) => (
				<section class="roleplay-media-inline" aria-labelledby="roleplay-inline-media-label">
					<header class="roleplay-media-header">
						<h3 id="roleplay-inline-media-label">{item().label}</h3>
						<Button
							data-control="command"
							type="button"
							aria-label={t("messages.closeMedia")}
							onClick={() => store.dismissRoleplayMedia()}
						>
							{t("messages.closeMedia")}
						</Button>
					</header>
					<RoleplayConversationMedia media={item()} />
				</section>
			)}
		</Show>
	);
}

function RoleplayMediaOverlays() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const view = useConversationViewWorkflow(store);
	const media = view.roleplayOverlayMedia;
	const ambientMedia = view.roleplayAmbientMedia;
	return (
		<>
			<Dialog
				open={media() !== undefined}
				onOpenChange={(open) => !open && store.dismissRoleplayMedia()}
			>
				<Dialog.Portal>
					<Dialog.Overlay class="roleplay-media-overlay" />
					<Dialog.Content class="roleplay-media-dialog">
						<Show when={media()}>
							{(item) => (
								<>
									<Dialog.Title class="sr-only">{item().label}</Dialog.Title>
									<RoleplayConversationMedia media={item()} />
								</>
							)}
						</Show>
						<Dialog.CloseButton
							as={Button}
							class="roleplay-media-close"
							aria-label={t("messages.closeMedia")}
						>
							{t("messages.closeMedia")}
						</Dialog.CloseButton>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
			<Show when={ambientMedia()}>
				{(item) => (
					<section class="roleplay-media-ambient" aria-labelledby="roleplay-ambient-media-label">
						<div class="roleplay-media-ambient-heading">
							<strong id="roleplay-ambient-media-label">{item().label}</strong>
							<Button
								data-control="command"
								type="button"
								aria-label={t("messages.stopMedia")}
								onClick={() => store.dismissAmbientMedia()}
							>
								{t("messages.stopMedia")}
							</Button>
						</div>
						<RoleplayConversationMedia media={item()} />
					</section>
				)}
			</Show>
		</>
	);
}

function RoleplayConversationMedia(props: {
	media: CharacterDisplay["roleplay"]["media"][number];
}) {
	if (props.media.kind === "audio")
		return (
			<audio
				autoplay
				controls
				loop={props.media.loop}
				src={props.media.url}
				aria-label={props.media.label}
			>
				<track kind="captions" src={props.media.captionsUrl} srclang="und" default />
			</audio>
		);
	if (props.media.kind === "video")
		return (
			<video
				autoplay
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
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
			? props.media.posterUrl
			: props.media.url;
	return <img src={source} alt={props.media.label} />;
}
