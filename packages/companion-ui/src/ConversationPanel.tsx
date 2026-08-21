import { i18n, useTranslation } from "@bear-harness/i18n";
import {
	faChevronLeft,
	faChevronRight,
	faEllipsis,
	faPen,
} from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kobalte/core/button";
import { Dialog } from "@kobalte/core/dialog";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { RESULT_LOCATE_EVENT, type ResultLocateDetail } from "./features/ResultSpace.js";
import { Icon } from "./Icon.js";
import type { CharacterDisplay, Message, MessageVersion } from "./stores/companion.js";
import { useCompanionStore } from "./stores/companion.js";
import { ThreadHead } from "./ThreadHead.js";
import { WorkTimelineItem } from "./WorkPanel.js";

/**
 * ConversationPanel: the live thread. Messages come from the store's active
 * conversation; user and assistant messages get role-based styling. Per plan
 * §7.9, message operations (regenerate, switch version, continue, edit,
 * package-labelled correction, branch) appear only on hover or keyboard focus
 * of the message — the buttons stay in the tab order so they are keyboard
 * reachable, just visually deferred.
 */

type CorrectScope = "once" | "session" | "always";

/** The adopted (or fallback latest) version of a message. */
function adoptedVersion(message: Message): MessageVersion | undefined {
	if (message.adoptedVersionId !== undefined) {
		const byId = message.versions.find((version) => version.id === message.adoptedVersionId);
		if (byId) return byId;
	}
	return message.versions.find((version) => version.adopted) ?? message.versions.at(-1);
}

function MessageItem(props: {
	message: Message;
	characterName: string;
	correction?: CharacterDisplay["character"]["correction"];
	lastAssistant: boolean;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [editing, setEditing] = createSignal(false);
	const [actionsOpen, setActionsOpen] = createSignal(false);
	const [editText, setEditText] = createSignal("");
	const [correcting, setCorrecting] = createSignal(false);
	const [reason, setReason] = createSignal("");
	const [customReason, setCustomReason] = createSignal("");
	const [scope, setScope] = createSignal<CorrectScope>("once");
	const [captureStatus, setCaptureStatus] = createSignal<"idle" | "success">("idle");
	const [actionBusy, setActionBusy] = createSignal(false);
	const [actionError, setActionError] = createSignal<string | null>(null);
	const runAction = async (action: () => Promise<unknown>): Promise<boolean> => {
		setActionBusy(true);
		setActionError(null);
		setCaptureStatus("idle");
		const before = store.errorMetadata;
		try {
			await action();
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) {
				setActionError(retained.message);
				return false;
			}
			return true;
		} catch (cause) {
			setActionError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setActionBusy(false);
		}
	};

	const isUser = () => props.message.role === "user";
	const version = () => adoptedVersion(props.message);
	const content = () => version()?.content ?? "";
	const versionIndex = () =>
		props.message.versions.findIndex((v) => v.id === (version()?.id ?? ""));
	const meta = () =>
		isUser()
			? t("messages.userMeta")
			: `${props.characterName} · ${formatTime(props.message.createdAt)}`;

	const switchTo = (index: number) => {
		const target = props.message.versions[index];
		if (target) void runAction(() => store.switchVersion(props.message.id, target.id));
	};

	const startEdit = () => {
		setActionError(null);
		setCaptureStatus("idle");
		setEditText(content());
		setActionsOpen(false);
		setEditing(true);
	};

	const saveEdit = async (): Promise<void> => {
		const text = editText().trim();
		if (!text || actionBusy()) return;
		const ok = await runAction(() => store.editMessage(props.message.id, text, isUser()));
		if (ok) setEditing(false);
	};

	const submitCorrect = () => {
		const text = reason() || customReason().trim();
		if (!text || actionBusy()) return;
		void runAction(() => store.correctMessage(text, scope())).then((ok) => {
			if (!ok) return;
			setReason("");
			setCustomReason("");
			setCorrecting(false);
		});
	};

	const captureMoment = async () => {
		if (actionBusy()) return;
		const ok = await runAction(() => store.memory.capture(props.message.id));
		if (ok) setCaptureStatus("success");
	};

	return (
		<article
			class={isUser() ? "msg user" : "msg bear-msg"}
			data-message-id={props.message.id}
			aria-label={meta()}
		>
			<Show when={actionError()}>
				{(error) => (
					<span class="status-line error" role="alert">
						{t("messages.operationFailedPrefix")}
						{error()}
					</span>
				)}
			</Show>
			<Show when={editing()}>
				<div class="msg-meta">{meta()}</div>
				<Show when={isUser()}>
					<p class="edit-branch-note">{t("messages.userEditBranchNote")}</p>
				</Show>
				<TextField>
					<TextField.TextArea
						class="edit-box"
						rows={3}
						value={editText()}
						onInput={(event) => setEditText(event.currentTarget.value)}
						aria-label={t("messages.editLabel")}
					/>
				</TextField>
				<div class="msg-tools">
					<Button type="button" class="primary-tool" disabled={actionBusy()} onClick={saveEdit}>
						{t("messages.save")}
					</Button>
					<Button data-control="command" type="button" onClick={() => setEditing(false)}>
						{t("messages.cancel")}
					</Button>
				</div>
			</Show>

			<Show when={!editing()}>
				<div class="msg-heading">
					<div class="msg-meta">{meta()}</div>
					<Show
						when={!isUser()}
						fallback={
							<Button
								type="button"
								class="msg-inline-action"
								aria-label={t("messages.edit")}
								title={t("messages.edit")}
								onClick={startEdit}
							>
								<Icon icon={faPen} />
							</Button>
						}
					>
						<Button
							type="button"
							class="msg-menu-trigger"
							aria-label={t("messages.operations")}
							title={t("messages.operations")}
							aria-expanded={actionsOpen()}
							onClick={() => setActionsOpen((open) => !open)}
						>
							<Icon icon={faEllipsis} />
						</Button>
					</Show>
				</div>
				<p>{content()}</p>

				<Show when={props.message.versions.length > 1}>
					<div class="version-pager" role="toolbar" aria-label={t("messages.versionPager")}>
						<Button
							data-control="command"
							type="button"
							aria-label={t("messages.previousVersion")}
							title={t("messages.previousVersion")}
							disabled={actionBusy() || versionIndex() <= 0}
							onClick={() => switchTo(versionIndex() - 1)}
						>
							<Icon icon={faChevronLeft} />
						</Button>
						<span aria-live="polite">
							{versionIndex() + 1} / {props.message.versions.length}
						</span>
						<Button
							data-control="command"
							type="button"
							aria-label={t("messages.nextVersion")}
							title={t("messages.nextVersion")}
							disabled={actionBusy() || versionIndex() >= props.message.versions.length - 1}
							onClick={() => switchTo(versionIndex() + 1)}
						>
							<Icon icon={faChevronRight} />
						</Button>
					</div>
				</Show>

				<Show when={correcting()}>
					<div
						class="correct-panel"
						role="toolbar"
						aria-label={props.correction?.reason_group_label}
					>
						<div class="correct-reasons">
							<For
								each={[
									t("messages.correctionReasons.tone"),
									t("messages.correctionReasons.identity"),
									t("messages.correctionReasons.history"),
									t("messages.correctionReasons.userAction"),
									t("messages.correctionReasons.fictionReality"),
								]}
							>
								{(preset) => (
									<Button
										type="button"
										class={reason() === preset ? "selected" : undefined}
										onClick={() => {
											setReason(reason() === preset ? "" : preset);
											setCustomReason("");
										}}
									>
										{preset}
									</Button>
								)}
							</For>
						</div>
						<TextField>
							<TextField.Input
								type="text"
								placeholder={t("messages.otherReason")}
								value={customReason()}
								onInput={(event) => {
									setCustomReason(event.currentTarget.value);
									setReason("");
								}}
								aria-label={t("messages.otherReason")}
							/>
						</TextField>
						<div class="correct-scopes">
							<For each={["once", "session", "always"] as const}>
								{(option) => (
									<Button
										type="button"
										class={scope() === option ? "selected" : undefined}
										onClick={() => setScope(option)}
										aria-pressed={scope() === option}
									>
										{t(`messages.correctionScopes.${option}`)}
									</Button>
								)}
							</For>
						</div>
						<div class="msg-tools">
							<Button
								type="button"
								class="primary-tool"
								disabled={actionBusy() || (!reason() && customReason().trim().length === 0)}
								onClick={submitCorrect}
							>
								{t("messages.submitCorrection")}
							</Button>
							<Button data-control="command" type="button" onClick={() => setCorrecting(false)}>
								{t("messages.cancel")}
							</Button>
						</div>
					</div>
				</Show>

				<Show when={!correcting() && !isUser()}>
					<div
						class="msg-tools"
						classList={{ "is-open": actionsOpen() }}
						role="toolbar"
						aria-label={t("messages.operations")}
					>
						<Show when={props.message.role === "assistant"}>
							<Button
								data-control="command"
								type="button"
								disabled={actionBusy()}
								onClick={() => void captureMoment()}
							>
								{t("messages.rememberMoment")}
							</Button>
							<Show when={captureStatus() === "success"}>
								<span
									class="status-line ok"
									role="status"
									aria-label={t("messages.rememberMoment")}
								>
									{t("messages.rememberMoment")}
								</span>
							</Show>
						</Show>
						<Show when={!isUser()}>
							<Button
								data-control="command"
								type="button"
								disabled={actionBusy()}
								onClick={() => void runAction(() => store.regenerateMessage(props.message.id))}
							>
								{t("messages.regenerate")}
							</Button>
							<Button
								data-control="command"
								type="button"
								disabled={actionBusy()}
								onClick={startEdit}
							>
								{t("messages.edit")}
							</Button>
							<Show when={props.correction}>
								{(copy) => (
									<Button
										data-control="command"
										type="button"
										onClick={() => {
											setActionError(null);
											setReason("");
											setCustomReason("");
											setScope("once");
											setCorrecting(true);
										}}
									>
										{copy().trigger_label}
									</Button>
								)}
							</Show>
							<Show when={props.lastAssistant}>
								<Button
									data-control="command"
									type="button"
									disabled={actionBusy()}
									onClick={() => void runAction(() => store.continueConversation())}
								>
									{t("messages.continue")}
								</Button>
							</Show>
							<Button
								data-control="command"
								type="button"
								disabled={actionBusy()}
								onClick={() => void runAction(() => store.branchMessage(props.message.id))}
							>
								{t("messages.branch")}
							</Button>
						</Show>
						<Show when={isUser()}>
							<Button data-control="command" type="button" onClick={startEdit}>
								{t("messages.edit")}
							</Button>
						</Show>
					</div>
				</Show>
			</Show>
		</article>
	);
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return i18n.t("messages.justNow");
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function ConversationPanel(props: { character: CharacterDisplay | undefined }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const sceneTitle = () =>
		store.conversations.find((conversation) => conversation.id === store.activeConversationId)
			?.sceneTitle ??
		props.character?.character.scene_title ??
		"";
	// Wire snapshots may contain system/tool-result entries for internal
	// bookkeeping. Keep those entries in the store, but never expose them in
	// the user-facing thread.
	const visibleMessages = () =>
		store.activeMessages.filter(
			(message) => message.role === "user" || message.role === "assistant",
		);

	// Derive conversation controls from the visible projection as well. An
	// internal entry after an assistant reply must not hide that reply's
	// "继续" operation or suppress draft reconciliation.

	let threadRef: HTMLElement | undefined;

	// Id of the last assistant message: only it gets the "继续" op.
	const lastAssistant = () => visibleMessages().at(-1);
	const lastAssistantId = () => {
		const last = lastAssistant();
		return last?.role === "assistant" ? last.id : null;
	};

	// Draft content that is not yet superseded by the persisted projection.
	// Pi session entry ids differ from the ids stream events carry, so the
	// streamed text is reconciled against the persisted final by content and
	// hidden once the final message has landed — rendering both would show the
	// reply twice.
	const streamedContent = () => {
		const draft = store.streamingAssistantText;
		if (draft.length === 0) return "";
		const last = lastAssistant();
		if (!last || last.role !== "assistant") return draft;
		const lastAdopted = last.versions.at(-1)?.content ?? "";
		return lastAdopted.trim() === draft.trim() ? "" : draft;
	};

	createEffect(() => {
		// Track the message count so the thread follows new messages.
		void visibleMessages().length;
		const el = threadRef;
		if (el) el.scrollTop = el.scrollHeight;
	});

	createEffect(() => {
		// "定位到对话" (plan §5.2): scroll and focus the source message and its
		// action line without changing the open result selection.
		const onLocate = (event: Event) => {
			const detail = (event as CustomEvent<ResultLocateDetail>).detail;
			if (!detail || detail.conversationId !== store.activeConversationId) return;
			const target = document.querySelector<HTMLElement>(`[data-message-id="${detail.messageId}"]`);
			if (!target) return;
			target.scrollIntoView?.({ block: "center" });
			const message = target.closest(".msg") as HTMLElement | null;
			if (message) {
				message.setAttribute("tabindex", "-1");
				message.focus({ preventScroll: true });
			}
		};
		window.addEventListener(RESULT_LOCATE_EVENT, onLocate);
		onCleanup(() => window.removeEventListener(RESULT_LOCATE_EVENT, onLocate));
	});

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
				<Show when={store.error !== null}>
					<div class="thread-error" role="alert">
						{t("messages.operationFailedPrefix")}
						{store.error}
					</div>
				</Show>

				<Show
					when={
						visibleMessages().length > 0 ||
						store.pendingUserText !== undefined ||
						store.assistantStreaming ||
						store.streamingAssistantText.length > 0
					}
					fallback={
						<Show when={props.character}>
							{(character) => (
								<div class="msg bear-msg">
									<div class="msg-meta">
										{character().name} · {character().character.scene_title}
									</div>
									<p>{character().character.greeting}</p>
								</div>
							)}
						</Show>
					}
				>
					<For each={visibleMessages()}>
						{(message) => (
							<>
								<MessageItem
									message={message}
									characterName={props.character?.name ?? ""}
									correction={props.character?.character.correction}
									lastAssistant={message.role === "assistant" && message.id === lastAssistantId()}
								/>
								{/* Message-scoped work action lines: only commissions whose
								    triggerMessageId matches this message render here. */}
								<Show when={message.role === "user"}>
									<WorkTimelineItem messageId={message.id} character={props.character} />
								</Show>
							</>
						)}
					</For>
					<Show when={store.pendingUserText}>
						{(text) => (
							<article class="msg user optimistic-message" aria-label={t("messages.userMeta")}>
								<div class="msg-meta">{t("messages.userMeta")}</div>
								<p>{text()}</p>
							</article>
						)}
					</Show>
					<Show when={store.toolActivities.length > 0}>
						<details class="tool-trace" open={store.assistantStreaming}>
							<summary>{store.toolActivities.at(-1)?.label}</summary>
							<ul>
								<For each={store.toolActivities}>
									{(activity) => (
										<li data-status={activity.status}>
											<strong>{activity.label}</strong>
											<span>{activity.message}</span>
										</li>
									)}
								</For>
							</ul>
						</details>
					</Show>
					<Show when={streamedContent().length > 0 || store.assistantStreaming}>
						<article
							class="msg bear-msg streaming-message"
							aria-label={props.character?.name ?? ""}
						>
							<div class="msg-meta">{props.character?.name ?? ""}</div>
							<p>{streamedContent()}</p>
							<Show when={store.assistantStreaming}>
								<span
									class="streaming-status"
									role="status"
									aria-label={t("messages.responding")}
								/>
							</Show>
						</article>
					</Show>
				</Show>
				<RoleplayChoices character={props.character} />
				<RoleplayInlineMedia character={props.character} />
			</section>
			<RoleplayMediaOverlays character={props.character} />
		</>
	);
}

function RoleplayChoices(props: { character: CharacterDisplay | undefined }) {
	const store = useCompanionStore();
	const choiceSet = () =>
		props.character?.roleplay.choice_sets?.find(
			(entry) => entry.id === store.activeRoleplayChoiceSetId,
		);
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

function RoleplayInlineMedia(props: { character: CharacterDisplay | undefined }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const media = () => {
		const item = props.character?.roleplay.media.find(
			(entry) => entry.id === store.activeRoleplayMediaId,
		);
		return item && item.presentation === "inline" ? item : undefined;
	};
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

function RoleplayMediaOverlays(props: { character: CharacterDisplay | undefined }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const media = () => {
		const item = props.character?.roleplay.media.find(
			(entry) => entry.id === store.activeRoleplayMediaId,
		);
		return item && item.presentation !== "inline" && item.presentation !== "ambient"
			? item
			: undefined;
	};
	const ambientMedia = () => {
		const item = props.character?.roleplay.media.find(
			(entry) => entry.id === store.activeAmbientMediaId,
		);
		return item && item.kind === "audio" && item.presentation === "ambient" ? item : undefined;
	};
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
