import { i18n, useTranslation } from "@bear-harness/i18n";
import type { CharacterMedia, PiSessionEntry } from "@bear-harness/protocol";
import {
	faChevronLeft,
	faChevronRight,
	faCodeBranch,
	faCompress,
	faCopy,
	faExpand,
	faImage,
	faMusic,
	faPen,
	faPlay,
} from "@fortawesome/free-solid-svg-icons";
import {
	createWindowVirtualizer,
	defaultRangeExtractor,
	type Range,
} from "@tanstack/solid-virtual";
import {
	createMemo,
	createSignal,
	For,
	type JSX,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { Icon } from "./Icon.js";
import { finishMotionExitImmediately } from "./lib/motion.js";
import {
	installTimelineScrollProtection,
	installVirtualTimelineFollow,
	notifyTimelineUserSent,
	type TimelineScrollController,
} from "./lib/timeline-scroll.js";
import { reconcileVirtualTimelineMeasurements } from "./lib/virtual-timeline.js";
import { MessageContent } from "./MessageContent.js";
import { NativeMessageContent, nativeRecord, nativeSource } from "./NativeMessageContent.js";
import {
	type ConversationSubmission,
	type TimelineProjectionItem,
	useCompanionStore,
} from "./stores/companion.js";

import { useConversationViewWorkflow } from "./stores/conversation-workflows.js";
import { ThreadHead } from "./ThreadHead.js";
import { Button, Dialog, TextField } from "./ui/primitives.js";
import { DelegatedRunCard, WorkRunCard, WorkTimelineItem } from "./WorkPanel.js";

type PiSessionEntryId = PiSessionEntry["id"];
const MAX_REMEMBERED_TOOL_DISCLOSURES = 32;

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

function messageContentIsLong(content: unknown): boolean {
	let length = 0;
	let lines = 1;
	const count = (value: string) => {
		length += value.length;
		for (const character of value) if (character === "\n") lines += 1;
		return length >= 1_200 || lines >= 16;
	};
	if (typeof content === "string") return count(content);
	if (!Array.isArray(content)) return false;
	let sawText = false;
	for (const part of content) {
		if (
			part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part
		) {
			if (sawText) lines += 1;
			sawText = true;
			if (count(String(part.text))) return true;
		}
	}
	return false;
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

function displayErrorMessage(value: string): string {
	const objectStart = value.indexOf("{");
	if (objectStart < 0) return value;
	try {
		const parsed = JSON.parse(value.slice(objectStart)) as unknown;
		if (!parsed || typeof parsed !== "object") return value;
		const record = parsed as Record<string, unknown>;
		if (typeof record.message === "string") return record.message;
		if (typeof record.error === "string") return record.error;
		if (record.error && typeof record.error === "object") {
			const nested = record.error as Record<string, unknown>;
			if (typeof nested.message === "string") return nested.message;
		}
		return value;
	} catch {
		return value;
	}
}

function PiTimelineEntryView(props: {
	startNavigationInHeading?: boolean;
	onEndAnchor?: (element: HTMLSpanElement) => void;
	entry: PiSessionEntry;
	onPreviewMedia(media: CharacterMedia): void;
	canEdit: boolean;
	canCorrect: boolean;
	canBranch: boolean;
	versionPager?: {
		leafIds: readonly PiSessionEntryId[];
		activeLeafId: PiSessionEntryId;
		disabled: boolean;
	};
}) {
	const store = useCompanionStore();
	const [t] = useTranslation(undefined, { i18n });
	const [editing, setEditing] = createSignal(false);
	const [editText, setEditText] = createSignal("");
	const [correcting, setCorrecting] = createSignal(false);
	const [correctionDetail, setCorrectionDetail] = createSignal("");
	const [actionBusy, setActionBusy] = createSignal(false);
	const messageActionBusy = () => actionBusy() || store.conversationMutationBusy;
	const [actionError, setActionError] = createSignal<string | null>(null);
	const [copiedTarget, setCopiedTarget] = createSignal<
		"message" | { partIndex: number; codeIndex: number } | null
	>(null);
	const copiedCode = () => {
		const target = copiedTarget();
		return target !== null && typeof target === "object" ? target : undefined;
	};
	let editOpener: HTMLButtonElement | undefined;
	let correctionOpener: HTMLButtonElement | undefined;
	let correctionInput: HTMLInputElement | undefined;
	let messageStartRef: HTMLSpanElement | undefined;
	let messageEndRef: HTMLSpanElement | undefined;
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => {
		if (copiedTimer !== undefined) clearTimeout(copiedTimer);
	});
	const entry = props.entry;
	if (entry.type !== "message") return <NativeEntryNotice entry={entry} />;
	const message = entry.message;
	if (message.role === "toolResult") return null; // Rendered through the shared live/settled tool view.
	if (message.role !== "user" && message.role !== "assistant")
		return <NativeEntryNotice entry={entry} />;
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
	const failed = () =>
		assistant()?.stopReason === "error" ||
		assistant()?.stopReason === "aborted" ||
		!!assistant()?.errorMessage;
	const content = () => {
		const current = currentMessage();
		return "content" in current ? current.content : undefined;
	};
	const errorText = () =>
		assistant()?.stopReason === "aborted"
			? t("messages.responseStopped")
			: (assistant()?.errorMessage
					? displayErrorMessage(assistant()?.errorMessage ?? "")
					: undefined) ||
				(assistant()?.stopReason === "error" ? t("messages.responseFailedSaved") : undefined);
	const longResponse = () => !isUser && messageContentIsLong(content());
	const hasResponseText = () => !isUser && text().trim().length > 0;
	if (
		!isUser &&
		Array.isArray(message.content) &&
		message.content.every(
			(part) =>
				part.type === "toolCall" ||
				(part.type === "thinking" && (!part.thinking || part.redacted === true)),
		) &&
		!failed()
	)
		return null;
	const runAction = async (
		action: () => Promise<void>,
		setError: (value: string | null) => void = setActionError,
	) => {
		if (messageActionBusy()) return false;
		setActionBusy(true);
		setError(null);
		try {
			await action();
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setActionBusy(false);
		}
	};
	const dismissEdit = () => {
		setEditing(false);
		queueMicrotask(() => {
			const focusTarget = editOpener?.isConnected
				? editOpener
				: document.querySelector<HTMLButtonElement>('[data-message-action="edit"]');
			focusTarget?.focus();
		});
	};
	const commitEdit = () => {
		const value = editText().trim();
		if (!value) return;
		if (value === text()) {
			dismissEdit();
			return;
		}
		const previousId = store.activeSubmission?.id;
		const request = store.editMessage(props.entry.id, value);
		const staged = store.activeSubmission?.id !== previousId;
		if (staged) dismissEdit();
		void request.catch((cause) => {
			if (!staged) setActionError(cause instanceof Error ? cause.message : String(cause));
		});
	};
	const dismissCorrection = () => {
		if (messageActionBusy()) return;
		setCorrecting(false);
	};
	const submitCorrection = (feedback: string) => {
		const value = feedback.trim();
		if (!value) return;
		const previousId = store.activeSubmission?.id;
		const request = store.correctMessage(props.entry.id, value);
		const staged = store.activeSubmission?.id !== previousId;
		if (staged) {
			setCorrecting(false);
			setCorrectionDetail("");
		}
		void request.catch((cause) => {
			if (!staged) setActionError(cause instanceof Error ? cause.message : String(cause));
		});
	};
	const copyText = async (
		value: string,
		target: "message" | { partIndex: number; codeIndex: number },
	) => {
		if (typeof navigator === "undefined" || !navigator.clipboard) return;
		await navigator.clipboard.writeText(value);
		setCopiedTarget(target);
		if (copiedTimer !== undefined) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => {
			copiedTimer = undefined;
			setCopiedTarget(null);
		}, 1_500);
	};
	const selectedVersionIndex = () => {
		const pager = props.versionPager;
		return pager ? pager.leafIds.indexOf(pager.activeLeafId) : -1;
	};
	const switchVersion = (offset: -1 | 1) => {
		const pager = props.versionPager;
		const target = pager?.leafIds[selectedVersionIndex() + offset];
		if (!target || pager.disabled || messageActionBusy()) return;
		void runAction(() => store.switchMessageVersion(target));
	};
	return (
		<div class="timeline-entry-row" data-testid="timeline-entry-row">
			<div class={isUser ? "user-message-column" : "agent-message-column"}>
				<article
					class={`msg pi-timeline-message ${isUser ? "user" : "bear-msg"}${failed() ? " stream-failed" : ""}`}
					data-testid="timeline-message"
					data-pi-entry-id={props.entry.id}
					aria-label={isUser ? t("messages.you") : characterName()}
				>
					<span ref={messageStartRef} class="message-scroll-anchor" />
					<Show
						when={
							isUser || (hasResponseText() && longResponse() && !props.startNavigationInHeading)
						}
					>
						<div class="msg-heading">
							<Show when={isUser}>
								<div class="msg-meta">{t("messages.you")}</div>
							</Show>
							<div class="message-direct-actions">
								<Show when={longResponse()}>
									<Button
										type="button"
										class="msg-text-action"
										onClick={() => messageEndRef?.scrollIntoView({ block: "end" })}
									>
										{t("messages.jumpToResponseEnd")}
									</Button>
								</Show>
								<Show when={props.canEdit && isUser}>
									<Button
										ref={(element) => {
											editOpener = element;
										}}
										type="button"
										class="msg-inline-action"
										aria-label={t("messages.edit")}
										data-message-action="edit"
										title={t("messages.edit")}
										disabled={messageActionBusy()}
										onClick={() => {
											setEditText(text());
											setEditing(true);
										}}
									>
										<Icon icon={faPen} />
									</Button>
								</Show>
								<Show when={isUser}>
									<Button
										type="button"
										class="msg-inline-action"
										aria-label={
											copiedTarget() === "message" ? t("messages.copied") : t("messages.copy")
										}
										title={copiedTarget() === "message" ? t("messages.copied") : t("messages.copy")}
										disabled={messageActionBusy()}
										onClick={() => void copyText(text(), "message")}
									>
										<Icon icon={faCopy} />
									</Button>
								</Show>
							</div>
						</div>
					</Show>
					<Show when={!editing()}>
						<NativeMessageContent
							content={content()}
							format={isUser ? "plain" : "markdown"}
							codeCopyLabel={t("messages.copyCode")}
							codeCopiedLabel={t("messages.codeCopied")}
							copiedCode={copiedCode()}
							onCopyCode={
								isUser
									? undefined
									: (code, partIndex, codeIndex) => void copyText(code, { partIndex, codeIndex })
							}
						/>
					</Show>
					<span
						ref={(element) => {
							messageEndRef = element;
							props.onEndAnchor?.(element);
						}}
						class="message-scroll-anchor"
					/>
					<Show when={editing() && isUser}>
						<div class="message-inline-edit motion-feedback">
							<TextField class="message-inline-editor">
								<TextField.TextArea
									autofocus
									value={editText()}
									onInput={(event) => setEditText(event.currentTarget.value)}
									onKeyDown={(event) => {
										if (
											event.key === "Enter" &&
											!event.shiftKey &&
											!event.isComposing &&
											!messageActionBusy()
										) {
											event.preventDefault();
											void commitEdit();
										}
										if (event.key === "Escape" && !messageActionBusy()) {
											event.preventDefault();
											dismissEdit();
										}
									}}
									aria-label={t("messages.editLabel")}
									disabled={messageActionBusy()}
								/>
							</TextField>
							<p class="message-edit-note">{t("messages.userEditBranchNote")}</p>
							<div class="message-inline-edit-actions">
								<Button type="button" disabled={messageActionBusy()} onClick={dismissEdit}>
									{t("messages.cancel")}
								</Button>
								<Button
									type="button"
									disabled={messageActionBusy() || !editText().trim()}
									onClick={() => void commitEdit()}
								>
									{t("messages.save")}
								</Button>
							</div>
						</div>
					</Show>
					<Show when={failed() && (errorText()?.length ?? 0) > 0}>
						<span class="stream-error motion-feedback" role="alert">
							{errorText()}
						</span>
					</Show>
					<Show when={hasResponseText() && !editing()}>
						<footer class="message-response-actions" data-testid="message-response-actions">
							<Button type="button" onClick={() => void copyText(text(), "message")}>
								<Icon icon={faCopy} />
								{copiedTarget() === "message"
									? t("messages.copied")
									: longResponse()
										? t("messages.copyFullResponse")
										: t("messages.copy")}
							</Button>
							<Show when={longResponse()}>
								<Button
									type="button"
									onClick={() => messageStartRef?.scrollIntoView({ block: "start" })}
								>
									{t("messages.jumpToResponseStart")}
								</Button>
							</Show>
							<Show when={props.canCorrect}>
								<Button
									ref={(element) => {
										correctionOpener = element;
									}}
									type="button"
									disabled={messageActionBusy()}
									onClick={() => {
										setCorrectionDetail("");
										setCorrecting(true);
									}}
								>
									{store.character?.character.correction.trigger_label}
								</Button>
							</Show>
							<Show when={props.canBranch}>
								<Button
									type="button"
									disabled={messageActionBusy()}
									onClick={() =>
										void runAction(() => store.createConversationFromEntry(props.entry.id))
									}
								>
									<Icon icon={faCodeBranch} />
									{t("messages.branch")}
								</Button>
							</Show>
						</footer>
					</Show>
					<Show when={props.canCorrect && hasResponseText()}>
						<Dialog
							open={correcting()}
							modal
							onOpenChange={(open) => {
								if (!open) dismissCorrection();
							}}
						>
							<Dialog.Portal>
								<Dialog.Overlay class="correction-popover-backdrop motion-fade" />
								<Dialog.Content
									class="message-correction-popover motion-modal"
									onOpenAutoFocus={(event) => {
										event.preventDefault();
										queueMicrotask(() => {
											if (correctionInput?.isConnected) correctionInput.focus();
										});
									}}
									onCloseAutoFocus={(event) => {
										event.preventDefault();
										if (correctionOpener?.isConnected) correctionOpener.focus();
									}}
								>
									<Dialog.Title class="sr-only">
										{store.character?.character.correction.trigger_label}
									</Dialog.Title>
									<div class="message-correction-presets">
										<For each={store.character?.character.correction.presets ?? []}>
											{(preset) => (
												<Button
													type="button"
													disabled={messageActionBusy()}
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
												ref={(element) => {
													correctionInput = element;
													queueMicrotask(() => {
														if (correcting() && element.isConnected) element.focus();
													});
												}}
												value={correctionDetail()}
												onInput={(event) => setCorrectionDetail(event.currentTarget.value)}
												placeholder={store.character?.character.correction.custom_placeholder}
												aria-label={store.character?.character.correction.custom_label}
												disabled={messageActionBusy()}
											/>
										</TextField>
										<Button
											type="submit"
											disabled={!correctionDetail().trim() || messageActionBusy()}
										>
											{store.character?.character.correction.custom_label}
										</Button>
									</form>
								</Dialog.Content>
							</Dialog.Portal>
						</Dialog>
					</Show>
					<Show when={actionError()}>
						{(error) => (
							<span class="stream-error motion-feedback" role="alert">
								{error()}
							</span>
						)}
					</Show>
				</article>
				<Show when={props.versionPager}>
					{(pager) => (
						<nav class="message-version-pager" aria-label={t("messages.versionPager")}>
							<Button
								type="button"
								aria-label={t("messages.previousVersion")}
								disabled={pager().disabled || messageActionBusy() || selectedVersionIndex() <= 0}
								onClick={() => switchVersion(-1)}
							>
								<Icon icon={faChevronLeft} />
							</Button>
							<span aria-live="polite">
								{selectedVersionIndex() + 1} / {pager().leafIds.length}
							</span>
							<Button
								type="button"
								aria-label={t("messages.nextVersion")}
								disabled={
									pager().disabled ||
									messageActionBusy() ||
									selectedVersionIndex() >= pager().leafIds.length - 1
								}
								onClick={() => switchVersion(1)}
							>
								<Icon icon={faChevronRight} />
							</Button>
						</nav>
					)}
				</Show>
			</div>
		</div>
	);
}

function SubmissionFeedback(props: { submission: ConversationSubmission }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	return (
		<section
			class="conversation-submission"
			data-testid="conversation-submission"
			data-kind={props.submission.kind}
			data-state={props.submission.state}
			aria-label={t(`messages.submission.${props.submission.kind}.label`)}
		>
			<strong>{t(`messages.submission.${props.submission.kind}.label`)}</strong>
			<p class="submission-text">{props.submission.text}</p>
			<p role="status" aria-live="polite" aria-atomic="true">
				{t(`messages.submission.${props.submission.kind}.${props.submission.state}`)}
				<Show when={props.submission.error}>
					<span class="stream-error">{props.submission.error}</span>
				</Show>
			</p>
			<Show when={props.submission.state === "failed" || props.submission.state === "unknown"}>
				<div class="message-inline-actions">
					<Button
						type="button"
						disabled={store.conversationMutationBusy}
						onClick={() => void store.retrySubmission(props.submission.id).catch(() => undefined)}
					>
						{t(
							props.submission.state === "unknown" && props.submission.kind !== "send"
								? "messages.submission.refresh"
								: "messages.retry",
						)}
					</Button>
					<Button type="button" onClick={() => store.dismissSubmission(props.submission.id)}>
						{t("messages.submission.dismiss")}
					</Button>
				</div>
			</Show>
			<Show when={props.submission.state === "accepted"}>
				<div class="message-inline-actions">
					<Show when={props.submission.error}>
						<Button
							type="button"
							disabled={store.conversationMutationBusy}
							onClick={() => void store.retrySubmission(props.submission.id).catch(() => undefined)}
						>
							{t("messages.submission.refresh")}
						</Button>
					</Show>
					<Button type="button" onClick={() => store.dismissSubmission(props.submission.id)}>
						{t("messages.submission.dismiss")}
					</Button>
				</div>
			</Show>
		</section>
	);
}

function QueuedUserProjection(props: { text: string; queue: "steering" | "followUp" }) {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<div class="timeline-entry-row timeline-entry-enter" data-testid="pi-queued-user-message">
			<div class="user-message-column">
				<article class="msg pi-timeline-message user" aria-label={t("messages.you")}>
					<div class="msg-meta">{t("messages.you")}</div>
					<MessageContent text={props.text} format="plain" />
					<span class="message-send-status">
						<span>{t(`messages.submission.queue.${props.queue}`)}</span>
					</span>
				</article>
			</div>
		</div>
	);
}

function NativeToolView(props: {
	toolName: string;
	toolCallId: string;
	status: "pending" | "running" | "completed" | "failed";
	args?: unknown;
	result?: unknown;
	entryId?: string;
	expanded: boolean;
	onExpandedChange(expanded: boolean): void;
	onPreviewMedia(media: CharacterMedia): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const result = () => nativeRecord(props.result);
	const payload = () => hostToolPayload(result()?.details);
	const status = () => t(`messages.toolActivity.${props.status}`);
	const actionLabel = () => {
		const action = nativeRecord(props.args)?.action;
		switch (props.toolName) {
			case "host_state":
				return action === "read"
					? t("messages.toolActivity.stateRead")
					: action === "update"
						? t("messages.toolActivity.stateUpdate")
						: props.toolName;
			case "role_skill":
				return t("messages.toolActivity.skill");
			case "host_delegate":
				return t("messages.toolActivity.delegate");
			case "host_run_read":
				return t("messages.toolActivity.runRead");
			case "host_media":
				return t("messages.toolActivity.media");
			case "host_choices":
				return t("messages.toolActivity.choices");
			default:
				return props.toolName;
		}
	};
	const summary = createMemo(() => {
		const args = nativeRecord(props.args);
		if (!args) return "";
		for (const key of [
			"command",
			"path",
			"file_path",
			"query",
			"instruction",
			"runId",
			"mediaId",
		]) {
			if (typeof args[key] === "string") {
				const firstLine = (args[key] as string).split("\n", 1)[0] ?? "";
				return `${firstLine.slice(0, 160)}${firstLine.length > 160 || (args[key] as string).includes("\n") ? "…" : ""}`;
			}
		}
		return "";
	});
	const media = () =>
		props.toolName === "host_media"
			? store.character?.media.find((item) => item.id === payload()?.mediaId)
			: undefined;
	const choices = () => (props.toolName === "host_choices" ? hostChoices(payload()) : undefined);
	const runId = () => {
		const data = payload();
		return props.toolName === "host_delegate" &&
			data?.accepted === true &&
			data.executor === "pi" &&
			typeof data.runId === "string"
			? data.runId
			: undefined;
	};
	return (
		<article
			class="msg pi-tool-result motion-feedback"
			aria-label={`${props.toolName} ${status()}`}
			data-status={props.status}
			data-tool-call-id={props.toolCallId}
			data-pi-entry-id={props.entryId}
			data-media-message={Boolean(media())}
		>
			<Show when={media()}>
				{(item) => (
					<div class="native-media-message">
						<MediaTimelineCard media={item()} onOpen={() => props.onPreviewMedia(item())} />
					</div>
				)}
			</Show>
			<details
				class="native-tool-disclosure"
				open={props.expanded}
				onToggle={(event) => props.onExpandedChange(event.currentTarget.open)}
			>
				<summary>
					<strong>{actionLabel()}</strong>
					<Show when={actionLabel() !== props.toolName}>
						<small>{props.toolName}</small>
					</Show>
					<span class="pi-tool-status">{status()}</span>
					<Show when={summary()}>
						<span class="native-tool-excerpt">{summary()}</span>
					</Show>
				</summary>
				<h4>{t("messages.native.arguments")}</h4>
				<Show when={props.args !== undefined} fallback={<p>{t("messages.native.noArguments")}</p>}>
					<pre>{nativeSource(props.args)}</pre>
				</Show>
				<h4>{t("messages.native.content")}</h4>
				<Show
					when={result()?.content !== undefined}
					fallback={
						<Show
							when={props.result !== undefined}
							fallback={<p>{t("messages.native.noResult")}</p>}
						>
							<pre>{nativeSource(props.result)}</pre>
						</Show>
					}
				>
					<NativeMessageContent content={result()?.content} format="plain" />
				</Show>
				<Show when={result()?.details !== undefined}>
					<h4>{t("messages.native.details")}</h4>
					<pre>{nativeSource(result()?.details)}</pre>
				</Show>
				<Show when={result()?.errorMessage !== undefined || result()?.error !== undefined}>
					<pre role="alert">{nativeSource(result()?.errorMessage ?? result()?.error)}</pre>
				</Show>
			</details>
			<Show when={choices()}>
				{(value) => (
					<section class="message-choices motion-feedback" aria-label={value().prompt}>
						<strong>{value().prompt}</strong>
						<div class="message-choice-list">
							<For each={value().items}>
								{(choice) => (
									<Button
										type="button"
										class="message-choice"
										disabled={
											store.activeSubmission?.state === "submitting" ||
											store.conversationMutationBusy
										}
										onClick={() => {
											if (store.activeConversationId)
												notifyTimelineUserSent(store.activeConversationId);
											void store.sendMessage(choice.message);
										}}
									>
										{choice.label}
									</Button>
								)}
							</For>
						</div>
					</section>
				)}
			</Show>
			<Show when={runId()}>{(id) => <DelegatedRunCard runId={id()} />}</Show>
		</article>
	);
}

function NativeEntryNotice(props: { entry: PiSessionEntry }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const value = () =>
		nativeRecord(props.entry.type === "message" ? props.entry.message : props.entry)!;
	const kind = () => value().role ?? value().type;
	const resultRun = () => {
		if (value().customType !== "host_external_agent_result") return undefined;
		const runId = nativeRecord(value().details)?.runId;
		return store.runs.find((run) => run.id === runId);
	};
	const hidden = () =>
		value().display === false || (kind() === "custom" && props.entry.type !== "message");
	const label = () => {
		if (value().customType === "host_external_agent_result")
			return t("messages.toolActivity.externalResult");
		switch (kind()) {
			case "custom_message":
			case "custom":
				return String(value().customType ?? t("messages.native.notice"));
			case "model_change":
				return t("messages.native.model");
			case "thinking_level_change":
				return t("messages.native.thinkingLevel");
			case "branch_summary":
			case "compaction":
			case "branchSummary":
			case "compactionSummary":
				return t("messages.native.summary");
			case "bashExecution":
				return t("messages.native.bash");
			default:
				return t("messages.native.notice");
		}
	};
	return (
		<Show when={!hidden()}>
			<article
				class="msg native-session-notice"
				data-pi-entry-id={props.entry.id}
				aria-label={label()}
			>
				<strong>{label()}</strong>
				<Switch
					fallback={
						<>
							<p>{t("messages.native.unsupported")}</p>
							<pre>{nativeSource(value())}</pre>
						</>
					}
				>
					<Match when={resultRun()}>
						{(run) => (
							<>
								<WorkRunCard run={run()} />
								<details>
									<summary>{t("messages.native.source")}</summary>
									<NativeMessageContent content={value().content} />
									<pre>{nativeSource(value().details)}</pre>
								</details>
							</>
						)}
					</Match>
					<Match when={kind() === "custom_message" || kind() === "custom"}>
						<NativeMessageContent content={value().content} />
						<Show when={value().details !== undefined}>
							<details>
								<summary>{t("messages.native.details")}</summary>
								<pre>{nativeSource(value().details)}</pre>
							</details>
						</Show>
					</Match>
					<Match when={kind() === "model_change"}>
						<p>
							{String(value().provider)} / {String(value().modelId)}
						</p>
					</Match>
					<Match when={kind() === "thinking_level_change"}>
						<p>{String(value().thinkingLevel)}</p>
					</Match>
					<Match when={typeof value().summary === "string"}>
						<NativeMessageContent content={value().summary} />
					</Match>
					<Match when={kind() === "bashExecution"}>
						<pre>{String(value().command)}</pre>
						<NativeMessageContent content={value().output} format="plain" />
						<Show when={value().truncated === true}>
							<p>{t("messages.native.truncatedOutput")}</p>
						</Show>
						<details>
							<summary>{t("messages.native.details")}</summary>
							<pre>
								{nativeSource({
									exitCode: value().exitCode,
									cancelled: value().cancelled,
									truncated: value().truncated,
									fullOutputPath: value().fullOutputPath,
									excludeFromContext: value().excludeFromContext,
								})}
							</pre>
						</details>
					</Match>
					<Match when={kind() === "label"}>
						<p>{String(value().label ?? "")}</p>
					</Match>
					<Match when={kind() === "session_info"}>
						<p>{String(value().name ?? "")}</p>
					</Match>
				</Switch>
			</article>
		</Show>
	);
}

function StreamingAssistantProjection(props: {
	item: Extract<TimelineProjectionItem, { kind: "streaming-assistant" }>;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const message = () => props.item.message;
	const content = () => message().content;
	const failed = () =>
		message().stopReason === "error" ||
		message().stopReason === "aborted" ||
		!!message().errorMessage;
	const errorText = () =>
		message().stopReason === "aborted"
			? t("messages.responseStopped")
			: (message().errorMessage ? displayErrorMessage(message().errorMessage ?? "") : undefined) ||
				(message().stopReason === "error" ? t("messages.responseFailedSaved") : undefined);
	const characterName = () => store.character?.name ?? "";
	return (
		<div
			class="timeline-entry-row timeline-entry-enter motion-timeline-entry"
			data-testid="streaming-assistant-message"
		>
			<div class="agent-message-column">
				<article
					class={`msg bear-msg streaming-message${failed() ? " stream-failed" : ""}`}
					aria-label={characterName()}
				>
					<NativeMessageContent
						content={content()}
						format="markdown"
						streaming={store.activePiLiveState?.isStreaming === true}
					/>
					<Show when={store.activePiLiveState?.isStreaming === true}>
						<span class="streaming-status motion-activity" aria-hidden="true" />
					</Show>
					<Show when={failed() && errorText()}>
						{(error) => (
							<span class="stream-error motion-feedback" role="alert">
								{error()}
							</span>
						)}
					</Show>
				</article>
			</div>
		</div>
	);
}

type VirtualTimelineItem =
	| TimelineProjectionItem
	| { kind: "history-control"; id: "history-control" };

function isUserTimelineItem(item: VirtualTimelineItem | undefined): boolean {
	return (
		item?.kind === "queued-user" ||
		item?.kind === "submission" ||
		(item?.kind === "entry" && item.entry.type === "message" && item.entry.message.role === "user")
	);
}

/** Presentation only: connect adjacent native process entries, never across dialogue. */
function processItem(item: VirtualTimelineItem | undefined): boolean {
	if (!item) return false;
	if (item.kind === "streaming-assistant") return !messageText(item.message.content).trim();
	if (item.kind === "tool-execution") return item.toolName !== "host_media";
	if (item.kind !== "entry") return false;
	if (item.entry.type !== "message") return item.entry.type !== "custom";
	const message = item.entry.message;
	if (message.role === "toolResult") return message.toolName !== "host_media";
	if (message.role === "user") return false;
	if (message.role === "assistant") return !messageText(message.content).trim();
	return true;
}

function PiTimelineRenderer(props: {
	items: readonly TimelineProjectionItem[];
	following: boolean;
	hasMoreBefore: boolean;
	historyLoading: boolean;
	onLoadOlder(): Promise<void>;
	onPreviewMedia(media: CharacterMedia): void;
	activeLeafId?: PiSessionEntryId;
	latestLeafIds: readonly PiSessionEntryId[];
}) {
	const store = useCompanionStore();
	const items = createMemo<readonly VirtualTimelineItem[]>(() => {
		// Invisible assistant tool envelopes are not extra visual process nodes.
		// Keep the authoritative projection unchanged; filter only this rendered list.
		const visible = props.items.filter((item) => {
			if (item.kind !== "entry" || item.entry.type !== "message") return true;
			const message = item.entry.message;
			if (
				message.role !== "assistant" ||
				message.errorMessage ||
				message.stopReason === "error" ||
				message.stopReason === "aborted"
			)
				return true;
			return !message.content.every(
				(part) =>
					part.type === "toolCall" ||
					(part.type === "thinking" && (!part.thinking || part.redacted === true)),
			);
		});
		return props.hasMoreBefore
			? [{ kind: "history-control", id: "history-control" }, ...visible]
			: visible;
	});
	const [scrollMargin, setScrollMargin] = createSignal(0);
	const [focusedItemId, setFocusedItemId] = createSignal<string>();
	const [expandedToolIds, setExpandedToolIds] = createSignal<ReadonlySet<string>>(new Set());
	let anchorFrame: number | undefined;
	let timelineRef: HTMLUListElement | undefined;
	const cancelAnchorRestoration = () => {
		if (anchorFrame === undefined) return;
		cancelAnimationFrame(anchorFrame);
		anchorFrame = undefined;
	};
	const turnActive = () =>
		store.activePiLiveState?.isStreaming === true ||
		store.activePiLiveState?.isCompacting === true ||
		store.activePiLiveState?.isRetrying === true ||
		store.activeSubmission?.state === "submitting" ||
		(store.activeActivity !== undefined && store.activeActivity.errorMessage === undefined);
	const latestAssistantId = createMemo(
		() =>
			[...items()]
				.reverse()
				.find(
					(item) =>
						item.kind === "entry" &&
						item.entry.type === "message" &&
						item.entry.message.role === "assistant",
				)?.id,
	);
	const itemIndexes = createMemo(
		() => new Map(items().map((item, index) => [item.id, index] as const)),
	);
	const itemsById = createMemo(() => new Map(items().map((item) => [item.id, item] as const)));
	// Display grouping only; native entries and virtual row identities remain untouched.
	const responseStarts = createMemo(() => {
		const starts = new Set<string>();
		let needsHeading = true;
		for (const item of items()) {
			if (isUserTimelineItem(item) || item.kind === "history-control") {
				needsHeading = true;
				continue;
			}
			const response =
				item.kind === "streaming-assistant" ||
				item.kind === "tool-execution" ||
				(item.kind === "entry" &&
					item.entry.type === "message" &&
					(item.entry.message.role === "assistant" || item.entry.message.role === "toolResult"));
			if (response && needsHeading) {
				starts.add(item.id);
				needsHeading = false;
			}
		}
		return starts;
	});
	const streamingItemId = createMemo(() => {
		for (let index = items().length - 1; index >= 0; index -= 1) {
			const item = items()[index];
			if (item?.kind === "streaming-assistant") return item.id;
		}
		return undefined;
	});
	const rangeExtractor = createMemo(() => {
		const pinnedIndexes = [focusedItemId(), streamingItemId()].flatMap((id) => {
			if (!id) return [];
			const index = itemIndexes().get(id);
			return index === undefined ? [] : [index];
		});
		return (range: Range) => {
			const indexes = new Set(defaultRangeExtractor(range));
			const scroller = document.scrollingElement ?? document.documentElement;
			if (scroller.scrollTop <= 72 && items().length > 0) indexes.add(0);
			if (
				scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 72 &&
				items().length > 0
			)
				indexes.add(items().length - 1);
			for (const index of pinnedIndexes) indexes.add(index);
			return [...indexes].sort((left, right) => left - right);
		};
	});
	const setToolExpanded = (id: string, expanded: boolean) =>
		setExpandedToolIds((current) => {
			if (current.has(id) === expanded) return current;
			const next = new Set(current);
			if (expanded) {
				next.delete(id);
				next.add(id);
				if (next.size > MAX_REMEMBERED_TOOL_DISCLOSURES) {
					const oldest = next.values().next().value;
					if (oldest !== undefined) next.delete(oldest);
				}
			} else next.delete(id);
			return next;
		});
	const virtualizer = createWindowVirtualizer<HTMLLIElement>({
		get count() {
			return items().length;
		},
		estimateSize: () => 128,
		getItemKey: (index) => items()[index]?.id ?? index,
		get rangeExtractor() {
			return rangeExtractor();
		},
		get scrollMargin() {
			return scrollMargin();
		},
		overscan: 8,
		gap: 8,
		anchorTo: "end",
		followOnAppend: false,
		useAnimationFrameWithResizeObserver: true,
	});
	const virtualItems = createMemo(() => virtualizer.getVirtualItems());
	const virtualItemsByKey = createMemo(() =>
		reconcileVirtualTimelineMeasurements(virtualItems(), items()),
	);
	const renderedVirtualKeys = createMemo(() => [...virtualItemsByKey().keys()]);
	const loadOlder = async () => {
		const anchor = Array.from(
			timelineRef?.querySelectorAll<HTMLElement>("[data-virtual-item-id]") ?? [],
		).find((element) => {
			const bounds = element.getBoundingClientRect();
			return (
				element.dataset.virtualItemId !== "history-control" &&
				bounds.bottom > 0 &&
				bounds.top < window.innerHeight
			);
		});
		const anchorId = anchor?.dataset.virtualItemId;
		const top = anchor?.getBoundingClientRect().top;
		await props.onLoadOlder();
		if (anchorId === undefined || top === undefined) return;
		const scroller = document.scrollingElement ?? document.documentElement;
		let framesRemaining = 8;
		const restoreAnchor = () => {
			anchorFrame = requestAnimationFrame(() => {
				anchorFrame = undefined;
				const current = Array.from(
					timelineRef?.querySelectorAll<HTMLElement>("[data-virtual-item-id]") ?? [],
				).find((element) => element.dataset.virtualItemId === anchorId);
				if (current) {
					scroller.scrollTop += current.getBoundingClientRect().top - top;
					window.dispatchEvent(new Event("scroll"));
				} else {
					const nextIndex = itemIndexes().get(anchorId);
					const target =
						nextIndex === undefined ? undefined : virtualizer.getOffsetForIndex(nextIndex, "start");
					if (target) {
						scroller.scrollTop = Math.max(0, target[0] - top);
						window.dispatchEvent(new Event("scroll"));
					}
				}
				framesRemaining -= 1;
				if (framesRemaining > 0) restoreAnchor();
			});
		};
		restoreAnchor();
	};
	onMount(() => {
		if (!timelineRef) return;
		const stopFollowing = installVirtualTimelineFollow(timelineRef, () => props.following);
		const userScrollEvents = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
		const updateScrollMargin = () => {
			if (timelineRef) setScrollMargin(timelineRef.getBoundingClientRect().top + window.scrollY);
		};
		updateScrollMargin();
		window.addEventListener("resize", updateScrollMargin, { passive: true });
		for (const eventName of userScrollEvents)
			window.addEventListener(eventName, cancelAnchorRestoration, { passive: true });
		onCleanup(() => {
			stopFollowing();
			cancelAnchorRestoration();
			window.removeEventListener("resize", updateScrollMargin);
			for (const eventName of userScrollEvents)
				window.removeEventListener(eventName, cancelAnchorRestoration);
		});
	});
	const toolArgs = createMemo(() => {
		const args = new Map<string, unknown>();
		for (const item of props.items) {
			const message =
				item.kind === "entry" && item.entry.type === "message" ? item.entry.message : undefined;
			if (message?.role !== "assistant") continue;
			for (const part of message.content)
				if (part.type === "toolCall") args.set(part.id, part.arguments);
		}
		return args;
	});
	return (
		<ul
			ref={timelineRef}
			class="virtual-timeline"
			aria-label={i18n.t("messages.conversation")}
			data-testid="virtual-timeline"
			data-item-count={props.items.length}
			style={{ height: `${virtualizer.getTotalSize()}px` }}
		>
			<For each={renderedVirtualKeys()}>
				{(key) => {
					let responseEnd: HTMLSpanElement | undefined;
					let lastVirtualItem = virtualItemsByKey().get(key);
					const virtualItem = () => {
						lastVirtualItem = virtualItemsByKey().get(key) ?? lastVirtualItem;
						return lastVirtualItem;
					};
					const item = () => itemsById().get(String(key));
					const itemId = () => item()?.id ?? String(key);
					const itemIndex = () => virtualItem()?.index ?? itemIndexes().get(itemId()) ?? 0;
					const virtualItemStart = () => virtualItem()?.start ?? 0;
					const historyItem = () => {
						const value = item();
						return value?.kind === "history-control" ? value : undefined;
					};
					const entryItem = () => {
						const value = item();
						return value?.kind === "entry" ? value : undefined;
					};
					const submissionItem = () => {
						const value = item();
						return value?.kind === "submission" ? value : undefined;
					};
					const queuedItem = () => {
						const value = item();
						return value?.kind === "queued-user" ? value : undefined;
					};
					const toolExecutionItem = () => {
						const value = item();
						if (value?.kind === "tool-execution") return value;
						if (
							value?.kind !== "entry" ||
							value.entry.type !== "message" ||
							value.entry.message.role !== "toolResult"
						)
							return;
						const message = value.entry.message;
						return {
							toolName: message.toolName,
							toolCallId: message.toolCallId,
							status: message.isError ? ("failed" as const) : ("completed" as const),
							args: toolArgs().get(message.toolCallId),
							result: message,
							entryId: value.entry.id,
						};
					};
					const streamingItem = () => {
						const value = item();
						return value?.kind === "streaming-assistant" ? value : undefined;
					};
					return (
						<li
							class="virtual-timeline-item"
							data-testid="virtual-timeline-item"
							data-index={itemIndex()}
							data-virtual-item-id={itemId()}
							data-timeline-process={processItem(item())}
							data-timeline-user={isUserTimelineItem(item())}
							data-response-start={responseStarts().has(itemId())}
							data-process-continues={processItem(item()) && processItem(items()[itemIndex() + 1])}
							aria-posinset={itemIndex() + 1}
							aria-setsize={items().length}
							onFocusIn={() => setFocusedItemId(item()?.id)}
							style={{
								transform: `translateY(${virtualItemStart() - scrollMargin()}px)`,
							}}
							ref={(element) => {
								element.dataset.index = String(itemIndex());
								virtualizer.measureElement(element);
							}}
						>
							<Show when={responseStarts().has(itemId())}>
								<header class="timeline-response-heading">
									<img
										class="agent-message-avatar"
										src={store.character?.visual.avatarUrl}
										alt=""
										aria-hidden="true"
										draggable={false}
									/>
									<span class="agent-message-name">{store.character?.name}</span>
									<Show
										when={(() => {
											const entry = entryItem()?.entry;
											return (
												entry?.type === "message" &&
												entry.message.role === "assistant" &&
												messageContentIsLong(entry.message.content)
											);
										})()}
									>
										<Button
											type="button"
											class="msg-text-action"
											onClick={() => responseEnd?.scrollIntoView({ block: "end" })}
										>
											{i18n.t("messages.jumpToResponseEnd")}
										</Button>
									</Show>
								</header>
							</Show>
							<Switch>
								<Match when={historyItem()}>
									<Button
										type="button"
										class="timeline-load-older"
										disabled={props.historyLoading}
										onClick={() => void loadOlder()}
									>
										{i18n.t(
											props.historyLoading
												? "messages.native.loadingHistory"
												: "messages.native.loadOlder",
										)}
									</Button>
								</Match>
								<Match when={toolExecutionItem()}>
									{(execution) => (
										<NativeToolView
											toolName={execution().toolName}
											toolCallId={execution().toolCallId}
											status={execution().status}
											args={execution().args}
											result={execution().result}
											entryId={entryItem()?.entry.id}
											expanded={expandedToolIds().has(itemId())}
											onExpandedChange={(expanded) => setToolExpanded(itemId(), expanded)}
											onPreviewMedia={props.onPreviewMedia}
										/>
									)}
								</Match>
								<Match when={entryItem()}>
									{(entryItem) => (
										<>
											<PiTimelineEntryView
												entry={entryItem().entry}
												startNavigationInHeading={responseStarts().has(itemId())}
												onEndAnchor={(element) => {
													responseEnd = element;
												}}
												onPreviewMedia={props.onPreviewMedia}
												canEdit={!turnActive()}
												canCorrect={!turnActive()}
												canBranch={!turnActive() && entryItem().id === latestAssistantId()}
												versionPager={
													entryItem().id === latestAssistantId() &&
													props.latestLeafIds.length > 1 &&
													props.activeLeafId !== undefined &&
													props.latestLeafIds.includes(props.activeLeafId)
														? {
																leafIds: props.latestLeafIds,
																activeLeafId: props.activeLeafId,
																disabled: turnActive(),
															}
														: undefined
												}
											/>
											<WorkTimelineItem messageId={entryItem().id} />
										</>
									)}
								</Match>
								<Match when={submissionItem()}>
									{(submission) => <SubmissionFeedback submission={submission().submission} />}
								</Match>
								<Match when={queuedItem()}>
									{(queued) => <QueuedUserProjection text={queued().text} queue={queued().queue} />}
								</Match>
								<Match when={streamingItem()}>
									{(streaming) => <StreamingAssistantProjection item={streaming()} />}
								</Match>
							</Switch>
						</li>
					);
				}}
			</For>
		</ul>
	);
}

export function ConversationPanel(props: {
	onPreviewMedia(media: CharacterMedia): void;
	composer?: JSX.Element;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const view = useConversationViewWorkflow(store);
	const { sceneLabel, hasThreadContent } = view;
	let threadRef: HTMLElement | undefined;
	let jumpButtonRef: HTMLButtonElement | undefined;
	let timelineScroll: TimelineScrollController | undefined;
	const [timelineFollowing, setTimelineFollowing] = createSignal(true);
	const activityLabel = createMemo(() => {
		const activity = store.activeActivity;
		if (!activity) return "";
		if (activity.kind === "tool")
			return `${t("messages.activity.tool")}: ${activity.toolName ?? ""}`;
		return t(`messages.activity.${activity.kind}`);
	});
	const connectTimelineScroll = () => {
		if (!timelineScroll && threadRef && jumpButtonRef)
			timelineScroll = installTimelineScrollProtection(
				threadRef,
				jumpButtonRef,
				setTimelineFollowing,
				(conversationId, distance) => store.reportTimelineScroll(conversationId, distance),
			);
	};
	onCleanup(() => {
		timelineScroll?.dispose();
	});
	const loadOlder = async () => {
		if (store.historyLoading) return;
		timelineScroll?.preserveReadingPosition();
		await store.loadOlderHistory();
	};

	return (
		<>
			<ThreadHead sceneLabel={sceneLabel()} />
			<section
				class="thread"
				aria-label={t("messages.conversation")}
				data-conversation-id={store.activeConversationId ?? ""}
				ref={(el) => {
					threadRef = el;
					connectTimelineScroll();
				}}
			>
				<Show when={store.error != null}>
					<div class="thread-error" role="alert">
						{store.error}
					</div>
				</Show>

				<Show when={store.liveConnectionStatus !== "connected"}>
					<div
						class="conversation-connection-status"
						data-testid="conversation-connection-status"
						role="status"
					>
						{t(
							`messages.connection.${store.liveConnectionStatus === "reconnecting" ? "reconnecting" : "connecting"}`,
						)}
					</div>
				</Show>
				<Show when={store.historyError}>
					<p class="thread-error" role="alert">
						{store.historyError}
					</p>
				</Show>
				<Show when={store.activeConversationId} keyed>
					{(_conversationId) => (
						<Show when={hasThreadContent()}>
							<PiTimelineRenderer
								items={store.activeTimeline}
								following={timelineFollowing()}
								hasMoreBefore={store.activePiBranch?.hasMoreBefore === true}
								historyLoading={store.historyLoading}
								onLoadOlder={loadOlder}
								activeLeafId={store.activePiBranch?.activeLeafId}
								latestLeafIds={store.activePiBranch?.latestLeafIds ?? []}
								onPreviewMedia={props.onPreviewMedia}
							/>
						</Show>
					)}
				</Show>
				<Show when={store.activeSubmission?.kind !== "send" && store.activeSubmission}>
					{(submission) => <SubmissionFeedback submission={submission()} />}
				</Show>
				<Show when={store.activeActivity}>
					{(activity) => (
						<div
							class="conversation-activity"
							data-testid="conversation-activity"
							data-activity={activity().kind}
							role="status"
							data-failed={activity().kind !== "retry" && activity().errorMessage !== undefined}
							aria-label={activityLabel()}
							aria-live="polite"
							aria-atomic="true"
						>
							<span data-testid="conversation-announcement">{activityLabel()}</span>
							<Show when={activity().kind === "retry" ? activity().attempt : undefined}>
								{(attempt) => (
									<span>
										{t("messages.activity.retryAttempt", {
											attempt: attempt(),
											maxAttempts: activity().maxAttempts ?? "?",
										})}
									</span>
								)}
							</Show>
							<Show when={activity().kind === "retry" && activity().delayMs !== undefined}>
								<span>
									{t("messages.activity.retryDelay", {
										seconds: Math.ceil((activity().delayMs ?? 0) / 1_000),
									})}
								</span>
							</Show>
							<Show when={activity().errorMessage}>
								<span class="stream-error">
									{t(
										activity().kind === "memory_capture"
											? "messages.activity.memoryCaptureFailed"
											: activity().kind === "memory_recall"
												? "messages.activity.memoryRecallFailed"
												: activity().kind === "retry"
													? "messages.activity.retryReason"
													: "messages.activity.failed",
									)}{" "}
									{activity().errorMessage}
								</span>
							</Show>
						</div>
					)}
				</Show>
			</section>
			<div class="conversation-dock">
				<Button
					type="button"
					class="timeline-jump-latest"
					hidden
					ref={(element) => {
						jumpButtonRef = element;
						connectTimelineScroll();
					}}
					onClick={() => timelineScroll?.scrollToLatest()}
				>
					{t("messages.returnToLatest")}
				</Button>
				{props.composer}
			</div>
		</>
	);
}

function MediaTimelineCard(props: { media: CharacterMedia; onOpen(): void }) {
	const [t] = useTranslation(undefined, { i18n });
	const [thumbnailFailed, setThumbnailFailed] = createSignal(false);
	const thumbnail = props.media.kind === "image" ? props.media.url : props.media.posterUrl;
	const playable = props.media.kind === "audio" || props.media.kind === "video";
	const action = createMemo(() => t(playable ? "messages.playMedia" : "messages.openMedia"));
	return (
		<section class="message-media-card" aria-label={props.media.label}>
			<Button
				class="message-media-trigger"
				type="button"
				aria-label={action()}
				onClick={props.onOpen}
			>
				<Show
					when={thumbnail && !thumbnailFailed()}
					fallback={
						<span class="message-media-placeholder">
							<Icon icon={props.media.kind === "audio" ? faMusic : playable ? faPlay : faImage} />
						</span>
					}
				>
					<img
						class="message-media-thumbnail"
						src={thumbnail}
						alt={props.media.label}
						loading="lazy"
						decoding="async"
						onError={() => setThumbnailFailed(true)}
					/>
				</Show>
				<span class="message-media-caption">
					<strong>{props.media.label}</strong>
					<span>{action()}</span>
				</span>
			</Button>
		</section>
	);
}

function CharacterMediaContent(props: { media: CharacterMedia; onError(): void }) {
	let player: HTMLMediaElement | undefined;
	onCleanup(() => {
		if (!player) return;
		player.pause();
		player.removeAttribute("src");
		player.load();
	});
	if (props.media.kind === "audio")
		return (
			<audio
				ref={(element) => {
					player = element;
				}}
				controls
				preload="metadata"
				loop={props.media.loop}
				src={props.media.url}
				aria-label={props.media.label}
				onError={props.onError}
			>
				<track kind="captions" src={props.media.captionsUrl} srclang="und" default />
			</audio>
		);
	if (props.media.kind === "video")
		return (
			<video
				ref={(element) => {
					player = element;
				}}
				preload="metadata"
				onError={props.onError}
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
	return <img src={source} alt={props.media.label} onError={props.onError} />;
}

export function MediaViewer(props: { media: CharacterMedia; onClose(): void }) {
	const [t] = useTranslation(undefined, { i18n });
	const [open, setOpen] = createSignal(true);
	const [expanded, setExpanded] = createSignal(false);
	const [originalSize, setOriginalSize] = createSignal(false);
	const [failed, setFailed] = createSignal(false);
	const image = props.media.kind === "image" || props.media.kind === "animation";
	const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
	let closeButton: HTMLButtonElement | undefined;
	let completed = false;
	const completeClose = () => {
		if (open() || completed) return;
		completed = true;
		props.onClose();
	};
	const requestClose = () => {
		if (!open()) return;
		setOpen(false);
		finishMotionExitImmediately(completeClose);
	};
	return (
		<Dialog open={open()} modal forceMount onOpenChange={(next) => !next && requestClose()}>
			<Dialog.Portal>
				<Dialog.Overlay class="media-viewer-backdrop motion-fade" />
				<Dialog.Content
					class="media-viewer motion-modal"
					data-bear-media-expanded={expanded()}
					onAnimationEnd={(event) => {
						if (event.target === event.currentTarget) completeClose();
					}}
					onAnimationCancel={(event) => {
						if (event.target === event.currentTarget) completeClose();
					}}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						closeButton?.focus();
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						if (opener?.isConnected) opener.focus();
					}}
				>
					<header class="media-viewer-header">
						<Dialog.Title>{props.media.label}</Dialog.Title>
						<div class="media-viewer-controls">
							<Show when={image && !failed()}>
								<Button
									type="button"
									aria-pressed={originalSize()}
									onClick={() => setOriginalSize((value) => !value)}
								>
									{t(originalSize() ? "messages.fitMedia" : "messages.originalMediaSize")}
								</Button>
							</Show>
							<Button
								type="button"
								class="media-viewer-expand"
								aria-label={t(expanded() ? "messages.restoreMedia" : "messages.expandMedia")}
								aria-pressed={expanded()}
								onClick={() => setExpanded((value) => !value)}
							>
								<Icon icon={expanded() ? faCompress : faExpand} />
							</Button>
							<Button
								ref={closeButton}
								type="button"
								aria-label={t("messages.closeMedia")}
								onClick={requestClose}
							>
								×
							</Button>
						</div>
					</header>
					<div class="media-viewer-content" data-original-size={originalSize()}>
						<Show when={!failed()} fallback={<p role="alert">{t("messages.mediaUnavailable")}</p>}>
							<CharacterMediaContent media={props.media} onError={() => setFailed(true)} />
						</Show>
					</div>
					<Dialog.Description class="media-viewer-description">
						{props.media.description}
					</Dialog.Description>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}
