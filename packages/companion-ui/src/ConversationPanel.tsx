import { productUi } from "@bear-harness/product-config";
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

const CORRECT_REASONS = productUi.messages.correctionReasons;

const CORRECT_SCOPES = productUi.messages.correctionScopes;

type CorrectScope = (typeof CORRECT_SCOPES)[number]["id"];

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
	const store = useCompanionStore();
	const [editing, setEditing] = createSignal(false);
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
			? productUi.messages.userMeta
			: `${props.characterName} · ${formatTime(props.message.createdAt)}`;

	const switchTo = (index: number) => {
		const target = props.message.versions[index];
		if (target) void store.switchVersion(props.message.id, target.id);
	};

	const startEdit = () => {
		setEditText(content());
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
		<div class={isUser() ? "msg user" : "msg bear-msg"} data-message-id={props.message.id}>
			<Show when={editing()}>
				<div class="msg-meta">{meta()}</div>
				<textarea
					class="edit-box"
					rows={3}
					value={editText()}
					onInput={(event) => setEditText(event.currentTarget.value)}
					aria-label={productUi.messages.editLabel}
				/>
				<div class="msg-tools">
					<button type="button" class="primary-tool" onClick={saveEdit}>
						{productUi.messages.save}
					</button>
					<button type="button" onClick={() => setEditing(false)}>
						{productUi.messages.cancel}
					</button>
				</div>
			</Show>

			<Show when={!editing()}>
				<div class="msg-meta">{meta()}</div>
				<p>{content()}</p>

				<Show when={props.message.versions.length > 1}>
					<div class="version-pager" role="toolbar" aria-label={productUi.messages.versionPager}>
						<button
							type="button"
							aria-label={productUi.messages.previousVersion}
							disabled={versionIndex() <= 0}
							onClick={() => switchTo(versionIndex() - 1)}
						>
							◀
						</button>
						<span aria-live="polite">
							{versionIndex() + 1} / {props.message.versions.length}
						</span>
						<button
							type="button"
							aria-label={productUi.messages.nextVersion}
							disabled={versionIndex() >= props.message.versions.length - 1}
							onClick={() => switchTo(versionIndex() + 1)}
						>
							▶
						</button>
					</div>
				</Show>

				<Show when={correcting()}>
					<div
						class="correct-panel"
						role="toolbar"
						aria-label={props.correction?.reason_group_label}
					>
						<div class="correct-reasons">
							<For each={CORRECT_REASONS}>
								{(preset) => (
									<button
										type="button"
										class={reason() === preset ? "selected" : undefined}
										onClick={() => {
											setReason(reason() === preset ? "" : preset);
											setCustomReason("");
										}}
									>
										{preset}
									</button>
								)}
							</For>
						</div>
						<input
							type="text"
							placeholder={productUi.messages.otherReason}
							value={customReason()}
							onInput={(event) => {
								setCustomReason(event.currentTarget.value);
								setReason("");
							}}
							aria-label={productUi.messages.otherReason}
						/>
						<div class="correct-scopes">
							<For each={CORRECT_SCOPES}>
								{(option) => (
									<button
										type="button"
										class={scope() === option.id ? "selected" : undefined}
										onClick={() => setScope(option.id)}
										aria-pressed={scope() === option.id}
									>
										{option.label}
									</button>
								)}
							</For>
						</div>
						<div class="msg-tools">
							<button
								type="button"
								class="primary-tool"
								disabled={!reason() && customReason().trim().length === 0}
								onClick={submitCorrect}
							>
								{productUi.messages.submitCorrection}
							</button>
							<button type="button" onClick={() => setCorrecting(false)}>
								{productUi.messages.cancel}
							</button>
						</div>
					</div>
				</Show>

				<Show when={!correcting()}>
					<div class="msg-tools" role="toolbar" aria-label={productUi.messages.operations}>
						<Show when={!isUser()}>
							<button type="button" onClick={() => void store.regenerateMessage(props.message.id)}>
								{productUi.messages.regenerate}
							</button>
							<button type="button" onClick={startEdit}>
								{productUi.messages.edit}
							</button>
							<Show when={props.correction}>
								{(copy) => (
									<button
										type="button"
										onClick={() => {
											setReason("");
											setCustomReason("");
											setScope("once");
											setCorrecting(true);
										}}
									>
										{copy().trigger_label}
									</button>
								)}
							</Show>
							<Show when={props.lastAssistant}>
								<button type="button" onClick={() => void store.continueConversation()}>
									{productUi.messages.continue}
								</button>
							</Show>
							<button type="button" onClick={() => void store.branchMessage(props.message.id)}>
								{productUi.messages.branch}
							</button>
						</Show>
						<Show when={isUser()}>
							<button type="button" onClick={startEdit}>
								{productUi.messages.edit}
							</button>
						</Show>
					</div>
				</Show>
			</Show>
		</div>
	);
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return productUi.messages.justNow;
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function ConversationPanel(props: { character: CharacterDisplay | undefined }) {
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
			aria-label={productUi.messages.conversation}
			ref={(el) => {
				threadRef = el;
			}}
		>
			<Show when={store.error !== null}>
				<div class="thread-error" role="alert">
					{productUi.messages.operationFailedPrefix}
					{store.error}
				</div>
			</Show>

			<Show
				when={store.activeMessages.length > 0}
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
			</Show>
		</section>
	);
}
