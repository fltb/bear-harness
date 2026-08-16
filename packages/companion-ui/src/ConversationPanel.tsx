import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { CharacterDisplay, Message, MessageVersion } from "./stores/companion.js";
import { useCompanionStore } from "./stores/companion.js";

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
		if (target) void store.switchVersion(props.message.id, target.id);
	};

	const startEdit = () => {
		setEditText(content());
		setActionsOpen(false);
		setEditing(true);
	};

	const saveEdit = () => {
		const text = editText().trim();
		if (!text) return;
		void store.editMessage(props.message.id, text, isUser());
		setEditing(false);
	};

	const submitCorrect = () => {
		const text = reason() || customReason().trim();
		if (!text) return;
		void store.correctMessage(text, scope());
		setReason("");
		setCustomReason("");
		setCorrecting(false);
	};

	return (
		<article
			class={isUser() ? "msg user" : "msg bear-msg"}
			data-message-id={props.message.id}
			aria-label={meta()}
		>
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
					<Button type="button" class="primary-tool" onClick={saveEdit}>
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
					<Button
						type="button"
						class="msg-menu-trigger"
						aria-label={t("messages.operations")}
						aria-expanded={actionsOpen()}
						onClick={() => setActionsOpen((open) => !open)}
					>
						···
					</Button>
				</div>
				<p>{content()}</p>

				<Show when={props.message.versions.length > 1}>
					<div class="version-pager" role="toolbar" aria-label={t("messages.versionPager")}>
						<Button
							data-control="command"
							type="button"
							aria-label={t("messages.previousVersion")}
							disabled={versionIndex() <= 0}
							onClick={() => switchTo(versionIndex() - 1)}
						>
							◀
						</Button>
						<span aria-live="polite">
							{versionIndex() + 1} / {props.message.versions.length}
						</span>
						<Button
							data-control="command"
							type="button"
							aria-label={t("messages.nextVersion")}
							disabled={versionIndex() >= props.message.versions.length - 1}
							onClick={() => switchTo(versionIndex() + 1)}
						>
							▶
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
								disabled={!reason() && customReason().trim().length === 0}
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

				<Show when={!correcting()}>
					<div
						class="msg-tools"
						classList={{ "is-open": actionsOpen() }}
						role="toolbar"
						aria-label={t("messages.operations")}
					>
						<Show when={!isUser()}>
							<Button
								data-control="command"
								type="button"
								onClick={() => void store.regenerateMessage(props.message.id)}
							>
								{t("messages.regenerate")}
							</Button>
							<Button data-control="command" type="button" onClick={startEdit}>
								{t("messages.edit")}
							</Button>
							<Show when={props.correction}>
								{(copy) => (
									<Button
										data-control="command"
										type="button"
										onClick={() => {
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
									onClick={() => void store.continueConversation()}
								>
									{t("messages.continue")}
								</Button>
							</Show>
							<Button
								data-control="command"
								type="button"
								onClick={() => void store.branchMessage(props.message.id)}
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

	let threadRef: HTMLElement | undefined;

	// Id of the last assistant message: only it gets the "继续" op.
	const lastAssistantId = () => {
		for (let i = store.activeMessages.length - 1; i >= 0; i -= 1) {
			const candidate = store.activeMessages[i];
			if (candidate && candidate.role === "assistant") return candidate.id;
		}
		return null;
	};

	createEffect(() => {
		// Track the message count so the thread follows new messages.
		void store.activeMessages.length;
		const el = threadRef;
		if (el) el.scrollTop = el.scrollHeight;
	});

	return (
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
					store.activeMessages.length > 0 ||
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
				<For each={store.activeMessages}>
					{(message) => (
						<MessageItem
							message={message}
							characterName={props.character?.name ?? ""}
							correction={props.character?.character.correction}
							lastAssistant={message.role === "assistant" && message.id === lastAssistantId()}
						/>
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
				<Show when={store.assistantStreaming || store.streamingAssistantText.length > 0}>
					<article class="msg bear-msg streaming-message" aria-label={props.character?.name ?? ""}>
						<div class="msg-meta">{props.character?.name ?? ""}</div>
						<p>{store.streamingAssistantText}</p>
						<Show when={store.assistantStreaming}>
							<span class="streaming-status" role="status" aria-label={t("messages.responding")} />
						</Show>
					</article>
				</Show>
			</Show>
		</section>
	);
}
