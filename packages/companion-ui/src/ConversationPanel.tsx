import { i18n, useTranslation } from "@bear-harness/i18n";
import type { ConversationAttachmentSummary, PiTimelineEntry } from "@bear-harness/protocol";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useAttachmentPreview } from "./features/AttachmentPreviewPanel.js";
import { followTimelineScroll } from "./lib/dom-effects.js";
import type { CharacterDisplay } from "./stores/companion.js";
import { useCompanionStore } from "./stores/companion.js";
import { useConversationViewWorkflow } from "./stores/conversation-workflows.js";
import type { RunInfo } from "./stores/ipc.js";
import { ThreadHead } from "./ThreadHead.js";
import { Button, Dialog, TextField } from "./ui/primitives.js";

/** ConversationPanel renders the active Pi timeline plus transient stream state. */

type AssistantTimelineEntry = Extract<PiTimelineEntry, { kind: "message"; role: "assistant" }>;

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
							data-testid="timeline-attachment-row"
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

function resultRunForEntry(entry: PiTimelineEntry, runs: readonly RunInfo[]): RunInfo | undefined {
	if (
		entry.kind !== "message" ||
		entry.role !== "assistant" ||
		!entry.attachments?.some((attachment) => attachment.kind === "generated")
	)
		return undefined;
	const entryTime = Date.parse(entry.timestamp);
	return runs
		.filter(
			(run) =>
				run.status === "completed" &&
				run.completedAt !== undefined &&
				Date.parse(run.completedAt) <= entryTime,
		)
		.sort(
			(left, right) => Date.parse(right.completedAt ?? "") - Date.parse(left.completedAt ?? ""),
		)[0];
}

function PiTimelineEntryView(props: {
	entry: PiTimelineEntry;
	onOpenResult: (entryId: string) => void;
}) {
	const store = useCompanionStore();
	const [t] = useTranslation(undefined, { i18n });
	const [editing, setEditing] = createSignal(false);
	const [editText, setEditText] = createSignal("");
	const [correcting, setCorrecting] = createSignal(false);
	const [operationsOpen, setOperationsOpen] = createSignal(false);
	const [correctionDetail, setCorrectionDetail] = createSignal("");
	const [captureState, setCaptureState] = createSignal<"idle" | "saving" | "saved" | "error">(
		"idle",
	);
	const entry = props.entry;
	const capturedByHost = () =>
		store.memory.entries()?.some((memory) => memory.sourceEntryId === entry.id) === true;
	const captured = () => captureState() === "saved" || capturedByHost();
	if (entry.kind !== "message") {
		// Native Pi context entries describe internal session bookkeeping. Rendering
		// each one as an unlabeled rule made model/level changes look like broken UI.
		return null;
	}
	if (entry.role === "tool") {
		const label = (() => {
			switch (entry.toolName) {
				case "role_skill":
					return t("messages.toolActivity.read");
				case "host_state":
					return t("messages.toolActivity.state");
				case "host_visual":
					return t("messages.toolActivity.expression");
				case "host_present":
					return t("messages.toolActivity.roleplayUpdate");
				case "host_attachment":
					return t("messages.toolActivity.attachmentRead");
				case "host_delegate":
					return t("messages.toolActivity.delegate");
				case "host_history":
				case "host_canon":
				case "host_memory":
					return t("messages.toolActivity.continuity");
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
	const resultRun = createMemo(() => resultRunForEntry(entry, store.runs));
	const failed = assistant?.stopReason === "error" || assistant?.stopReason === "aborted";
	const errorText =
		assistant?.stopReason === "aborted"
			? t("messages.responseStopped")
			: assistant?.errorMessage
				? t("messages.responseFailedSaved")
				: undefined;
	if (
		!isUser &&
		(entry.text === undefined || entry.text.length === 0) &&
		(entry.attachments?.length ?? 0) === 0 &&
		!failed
	) {
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
					<TimelineAttachmentRows attachments={entry.attachments} />
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
							disabled={captureState() === "saving" || captured()}
							onClick={() => {
								setCaptureState("saving");
								void store.memory
									.capture(entry.id)
									.then(() => setCaptureState("saved"))
									.catch(() => setCaptureState("error"));
							}}
						>
							{captureState() === "saving"
								? t("messages.rememberingMoment")
								: captured()
									? t("messages.rememberedMoment")
									: captureState() === "error"
										? t("messages.rememberFailed")
										: t("messages.rememberMoment")}
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
				<Show when={!isUser && resultRun() !== undefined}>
					<Button
						type="button"
						class="agent-result-trigger"
						data-testid="agent-result-trigger"
						onClick={() => props.onOpenResult(entry.id)}
					>
						<span>{resultRun()?.title}</span>
						<strong>{t("work.timeline.completed")}</strong>
					</Button>
					<article
						class="agent-result-inline-card"
						data-testid="agent-result-inline-card"
						aria-label={`${t("work.result.title")} · ${resultRun()?.title}`}
					>
						<header>
							<span>{t("work.result.title")}</span>
							<strong>{t("work.timeline.completed")}</strong>
						</header>
						<h3>{resultRun()?.title}</h3>
						<TimelineAttachmentRows attachments={entry.attachments} />
					</article>
				</Show>
			</div>
		</div>
	);
}

function PiTimelineRenderer(props: {
	entries: readonly PiTimelineEntry[];
	onOpenResult: (entryId: string) => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const visible = createMemo(() => {
		const result: Array<PiTimelineEntry | PiTimelineEntry[]> = [];
		let lastAssistantSignature: string | undefined;
		for (const entry of props.entries) {
			if (entry.kind !== "message") continue;
			if (entry.role === "tool" && entry.status === "succeeded") {
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
			if (
				(entry.text === undefined || entry.text.length === 0) &&
				(entry.attachments?.length ?? 0) === 0 &&
				entry.stopReason !== "error" &&
				entry.stopReason !== "aborted"
			) {
				continue;
			}
			const signature = JSON.stringify({
				text: entry.text ?? "",
				stopReason: entry.stopReason,
				errorMessage: entry.errorMessage ?? "",
				attachments: entry.attachments?.map((attachment) => attachment.id) ?? [],
			});
			if (signature === lastAssistantSignature) continue;
			lastAssistantSignature = signature;
			result.push(entry);
		}
		return result;
	});
	return (
		<For each={visible()}>
			{(item) => (
				<Show
					when={Array.isArray(item) && item.length > 1}
					fallback={
						<PiTimelineEntryView
							entry={Array.isArray(item) ? item[0]! : item}
							onOpenResult={props.onOpenResult}
						/>
					}
				>
					<details class="tool-activity-group">
						<summary>
							<span>{t("messages.toolActivity.generic")}</span>
							<span>
								{(item as PiTimelineEntry[]).length} · {t("messages.toolActivity.completed")}
							</span>
						</summary>
						<div class="tool-activity-details">
							<For each={item as PiTimelineEntry[]}>
								{(entry) => <PiTimelineEntryView entry={entry} onOpenResult={props.onOpenResult} />}
							</For>
						</div>
					</details>
				</Show>
			)}
		</For>
	);
}

function AgentResultPanel(props: {
	entry: AssistantTimelineEntry;
	run: RunInfo;
	onClose: () => void;
	onLocate: () => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<aside
			class="agent-result-panel"
			data-testid="agent-result-panel"
			aria-labelledby={`agent-result-title-${props.entry.id}`}
		>
			<header class="agent-result-panel-header">
				<div>
					<span class="agent-result-eyebrow">{t("work.result.title")}</span>
					<h2 id={`agent-result-title-${props.entry.id}`}>{props.run.title}</h2>
				</div>
				<Button
					type="button"
					class="agent-result-close"
					aria-label={t("work.result.close")}
					onClick={props.onClose}
				>
					<span aria-hidden="true">×</span>
				</Button>
			</header>
			<div class="agent-result-panel-body">
				<div class="agent-result-content-card">
					<div class="agent-result-status">
						<strong>{t("work.timeline.completed")}</strong>
						<span>{t("work.result.sourceFrom", { summary: props.run.title })}</span>
					</div>
					<Show when={props.entry.text !== undefined && props.entry.text.length > 0}>
						<p class="agent-result-summary">{props.entry.text}</p>
					</Show>
					<TimelineAttachmentRows attachments={props.entry.attachments} />
				</div>
			</div>
			<footer class="agent-result-panel-footer">
				<Button type="button" data-control="command" onClick={props.onLocate}>
					{t("work.result.locate")}
				</Button>
			</footer>
		</aside>
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
		<Show when={store.activePiLiveState?.streamingMessage}>
			{(live) => {
				const message = live();
				if (message === undefined) return null;
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

export function ConversationPanel() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const view = useConversationViewWorkflow(store);
	const { sceneLabel, hasThreadContent } = view;
	let threadRef: HTMLElement | undefined;
	const [loadingOlder, setLoadingOlder] = createSignal(false);
	const [resultSelection, setResultSelection] = createSignal<{
		entryId: string;
		latestKey: string;
	}>();
	const [dismissedResultKey, setDismissedResultKey] = createSignal<string>();
	const resultEntries = createMemo(() =>
		(store.activePiTimeline?.entries ?? []).filter(
			(entry): entry is AssistantTimelineEntry =>
				resultRunForEntry(entry, store.runs) !== undefined,
		),
	);
	const latestResult = createMemo(() => resultEntries().at(-1));
	const latestResultKey = createMemo(() => {
		const latest = latestResult();
		return latest ? `${store.activeConversationId ?? ""}:${latest.id}` : undefined;
	});
	const selectedResultEntry = createMemo(() => {
		const latest = latestResult();
		const latestKey = latestResultKey();
		if (!latest || !latestKey || dismissedResultKey() === latestKey) return undefined;
		const selection = resultSelection();
		return selection?.latestKey === latestKey
			? resultEntries().find((entry) => entry.id === selection.entryId)
			: latest;
	});
	const selectedResultRun = createMemo(() => {
		const entry = selectedResultEntry();
		return entry ? resultRunForEntry(entry, store.runs) : undefined;
	});
	const openResult = (entryId: string) => {
		const latestKey = latestResultKey();
		if (!latestKey) return;
		setDismissedResultKey(undefined);
		setResultSelection({ entryId, latestKey });
	};
	const closeResult = () => {
		setDismissedResultKey(latestResultKey());
		setResultSelection(undefined);
	};

	followTimelineScroll(
		() => threadRef,
		() =>
			`${store.activePiTimeline?.entries.length ?? 0}:${store.activeRoleplayChoiceSetId ?? ""}:${store.activeRoleplayMediaId ?? ""}`,
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
						{t("messages.connectionUnavailable")}
					</div>
				</Show>

				<Show when={hasThreadContent()}>
					<Show when={store.activePiTimeline}>
						{(timeline) => (
							<>
								<Show when={timeline().hasMoreBefore === true}>
									<Button
										type="button"
										class="timeline-load-older"
										disabled={loadingOlder()}
										onClick={() => {
											setLoadingOlder(true);
											void store.loadOlderMessages().finally(() => setLoadingOlder(false));
										}}
									>
										{loadingOlder() ? t("messages.loadingOlder") : t("messages.loadOlder")}
									</Button>
								</Show>
								<PiTimelineRenderer entries={timeline().entries} onOpenResult={openResult} />
							</>
						)}
					</Show>
					<PiLiveAssistantMessageView />
				</Show>
				<RoleplayChoices />
				<RoleplayInlineMedia />
			</section>
			<Show when={selectedResultEntry()}>
				{(entry) => (
					<Show when={selectedResultRun()}>
						{(run) => (
							<AgentResultPanel
								entry={entry()}
								run={run()}
								onClose={closeResult}
								onLocate={() => {
									document
										.querySelector(`[data-pi-entry-id="${entry().id}"]`)
										?.scrollIntoView({ behavior: "smooth", block: "center" });
								}}
							/>
						)}
					</Show>
				)}
			</Show>
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
									onClick={() =>
										void ("event" in choice
											? store.triggerRoleplayEvent(choice.event)
											: store.sendMessage(choice.message))
									}
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
