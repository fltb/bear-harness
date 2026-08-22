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
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js";
import { RESULT_LOCATE_EVENT, type ResultLocateDetail } from "./features/ResultSpace.js";
import { Icon } from "./Icon.js";
import type { CharacterDisplay, Message } from "./stores/companion.js";
import { useCompanionStore } from "./stores/companion.js";
import {
	createMessageWorkflow,
	useConversationViewWorkflow,
} from "./stores/conversation-workflows.js";
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

function MessageItem(props: {
	message: Message;
	characterName: string;
	correction?: CharacterDisplay["character"]["correction"];
	lastAssistant: boolean;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = createMessageWorkflow(
		store,
		() => props.message,
		() => props.characterName,
		() => props.correction!,
		(key: string) => t(key as never),
	);
	return (
		<article
			data-message-id={props.message.id}
			class={workflow.isUser() ? "msg user" : "msg bear-msg"}
			aria-label={workflow.meta()}
		>
			<Show when={workflow.actionError()}>
				{(error) => (
					<span class="status-line error" role="alert">
						{t("messages.operationFailedPrefix")}
						{error()}
					</span>
				)}
			</Show>
			<Show when={workflow.editing()}>
				<div class="msg-meta">{workflow.meta()}</div>
				<Show when={workflow.isUser()}>
					<p class="edit-branch-note">{t("messages.userEditBranchNote")}</p>
				</Show>
				<TextField>
					<TextField.TextArea
						class="edit-box"
						rows={3}
						value={workflow.editText()}
						onInput={(event) => workflow.setEditText(event.currentTarget.value)}
						aria-label={t("messages.editLabel")}
					/>
				</TextField>
				<div class="msg-tools">
					<Button type="button" class="primary-tool" disabled={workflow.actionBusy()} onClick={workflow.saveEdit}>
						{t("messages.save")}
					</Button>
					<Button data-control="command" type="button" onClick={() => workflow.setEditing(false)}>
						{t("messages.cancel")}
					</Button>
				</div>
			</Show>
			<Show when={!workflow.editing()}>
				<div class="msg-heading">
					<div class="msg-meta">{workflow.meta()}</div>
					<Show
						when={!workflow.isUser()}
						fallback={
							<Button
								type="button"
								class="msg-inline-action"
								aria-label={t("messages.edit")}
								title={t("messages.edit")}
								onClick={workflow.startEdit}
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
							aria-expanded={workflow.actionsOpen()}
							onClick={() => workflow.setActionsOpen(!workflow.actionsOpen())}
						>
							<Icon icon={faEllipsis} />
						</Button>
					</Show>
				</div>
				<Show
					when={props.message.status === "failed"}
					fallback={
						<Show when={workflow.isUser() || workflow.content().trim().length > 0}>
							<p>{workflow.content()}</p>
						</Show>
					}
				>
					<p class="status-line err message-failure" role="alert">
						{props.message.failureReason?.trim() || t("errors.generic")}
					</p>
				</Show>
				<Show when={props.message.versions.length > 1}>
					<div class="version-pager" role="toolbar" aria-label={t("messages.versionPager")}>
						<Button
							data-control="command"
							type="button"
							aria-label={t("messages.previousVersion")}
							title={t("messages.previousVersion")}
							disabled={workflow.actionBusy() || workflow.versionIndex() <= 0}
							onClick={() => workflow.switchTo(workflow.versionIndex() - 1)}
						>
							<Icon icon={faChevronLeft} />
						</Button>
						<span aria-live="polite">
							{workflow.versionIndex() + 1} / {props.message.versions.length}
						</span>
						<Button
							data-control="command"
							type="button"
							aria-label={t("messages.nextVersion")}
							title={t("messages.nextVersion")}
							disabled={
								workflow.actionBusy() || workflow.versionIndex() >= props.message.versions.length - 1
							}
							onClick={() => workflow.switchTo(workflow.versionIndex() + 1)}
						>
							<Icon icon={faChevronRight} />
						</Button>
					</div>
				</Show>
				<Show when={workflow.correcting()}>
					<div
						class="correct-panel"
						role="toolbar"
						aria-label={props.correction?.reason_group_label}
					>
						<div class="correct-reasons">
							<For each={workflow.correctionReasons()}>
								{(preset) => (
									<Button
										type="button"
										class={workflow.reason() === preset ? "selected" : undefined}
										onClick={() => {
											workflow.setReason(workflow.reason() === preset ? "" : preset);
											workflow.setCustomReason("");
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
								value={workflow.customReason()}
								onInput={(event) => {
									workflow.setCustomReason(event.currentTarget.value);
									workflow.setReason("");
								}}
								aria-label={t("messages.otherReason")}
							/>
						</TextField>
						<div class="correct-scopes">
							<For each={["once", "session", "always"] as const}>
								{(option) => (
									<Button
										type="button"
										class={workflow.scope() === option ? "selected" : undefined}
										onClick={() => workflow.setScope(option)}
										aria-pressed={workflow.scope() === option}
									>
										{t(`messages.correctionScopes.${option}` as never)}
									</Button>
								)}
							</For>
						</div>
						<div class="msg-tools">
							<Button
								type="button"
								class="primary-tool"
								disabled={
									workflow.actionBusy() ||
									(!workflow.reason() && workflow.customReason().trim().length === 0)
								}
								onClick={workflow.submitCorrect}
							>
								{t("messages.submitCorrection")}
							</Button>
							<Button data-control="command" type="button" onClick={() => workflow.setCorrecting(false)}>
								{t("messages.cancel")}
							</Button>
						</div>
					</div>
				</Show>
				<Show when={!workflow.correcting() && !workflow.isUser()}>
					<div
						class="msg-tools"
						classList={{ "is-open": workflow.actionsOpen() }}
						role="toolbar"
						aria-label={t("messages.operations")}
					>
						<Show when={props.message.role === "assistant"}>
							<Button
								data-control="command"
								type="button"
								disabled={workflow.actionBusy()}
								onClick={() => void workflow.captureMoment()}
							>
								{t("messages.rememberMoment")}
							</Button>
							<Show when={workflow.captureStatus() === "success"}>
								<span class="status-line ok" role="status" aria-label={t("messages.rememberMoment")}>
									{t("messages.rememberMoment")}
								</span>
							</Show>
						</Show>
						<Show when={!workflow.isUser()}>
							<Button
								data-control="command"
								type="button"
								disabled={workflow.actionBusy()}
								onClick={() => void workflow.runAction(() => store.regenerateMessage(props.message.id))}
							>
								{t("messages.regenerate")}
							</Button>
							<Button
								data-control="command"
								type="button"
								disabled={workflow.actionBusy()}
								onClick={workflow.startEdit}
							>
								{t("messages.edit")}
							</Button>
							<Show when={workflow.correction()}>
								{(copy) => (
									<Button
										data-control="command"
										type="button"
										onClick={() => {
											workflow.setActionError(null);
											workflow.setReason("");
											workflow.setCustomReason("");
											workflow.setScope("once");
											workflow.setCorrecting(true);
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
									disabled={workflow.actionBusy()}
									onClick={() => void workflow.runAction(() => store.continueConversation())}
								>
									{t("messages.continue")}
								</Button>
							</Show>
							<Button
								data-control="command"
								type="button"
								disabled={workflow.actionBusy()}
								onClick={() => void workflow.runAction(() => store.branchMessage(props.message.id))}
							>
								{t("messages.branch")}
							</Button>
						</Show>
						<Show when={workflow.isUser()}>
							<Button data-control="command" type="button" onClick={workflow.startEdit}>
								{t("messages.edit")}
							</Button>
						</Show>
					</div>
				</Show>
			</Show>
		</article>
	);
}


export function ConversationPanel(props: { character: CharacterDisplay | undefined }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const view = useConversationViewWorkflow(store, () => props.character);
	const toolActivities = createMemo(() => store.toolActivities ?? []);
	const { sceneTitle, visibleMessages, lastAssistantId, streamedContent, hasThreadContent } = view;
	let threadRef: HTMLElement | undefined;

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
				<Show when={store.error != null}>
					<div class="thread-error" role="alert">
						{t("messages.operationFailedPrefix")}
						{store.error}
					</div>
				</Show>

				<Show
					when={hasThreadContent()}
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
					<Show when={toolActivities().length > 0}>
						<details class="tool-trace" open={store.assistantStreaming}>
							<summary>{toolActivities().at(-1)?.label}</summary>
							<ul>
								<For each={toolActivities()}>
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
	const view = useConversationViewWorkflow(store, () => props.character);
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

function RoleplayInlineMedia(props: { character: CharacterDisplay | undefined }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const media = useConversationViewWorkflow(store, () => props.character).roleplayInlineMedia;
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
	const view = useConversationViewWorkflow(store, () => props.character);
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
