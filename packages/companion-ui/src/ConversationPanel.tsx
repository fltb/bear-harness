import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Dialog } from "@kobalte/core/dialog";
import { createEffect, For, onCleanup, Show } from "solid-js";
import { RESULT_LOCATE_EVENT, type ResultLocateDetail } from "./features/ResultSpace.js";
import type { CharacterDisplay } from "./stores/companion.js";
import type { PiTimelineEntry } from "@bear-harness/protocol";
import { useCompanionStore } from "./stores/companion.js";
import { useConversationViewWorkflow } from "./stores/conversation-workflows.js";
import { ThreadHead } from "./ThreadHead.js";
import { WorkTimelineItem } from "./WorkPanel.js";

/** ConversationPanel renders the active Pi timeline plus transient stream state. */


function PiTimelineEntryView(props: {
	entry: PiTimelineEntry;
	character: CharacterDisplay | undefined;
}) {
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
	const characterName = props.character?.name ?? "";
	const toolCalls = entry.role === "assistant" ? entry.toolCalls : undefined;
	return (
		<>
			<article
				class={`msg pi-timeline-message ${isUser ? "user" : "bear-msg"}`}
				data-pi-entry-id={entry.id}
				aria-label={isUser ? "user" : characterName}
			>
				<div class="msg-meta">{isUser ? "You" : characterName}</div>
				<Show when={entry.text !== undefined && entry.text.length > 0}>
					<p>{entry.text}</p>
				</Show>
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
			</article>
			<WorkTimelineItem messageId={entry.id} character={props.character} />
		</>
	);
}

function PiTimelineRenderer(props: {
	entries: readonly PiTimelineEntry[];
	character: CharacterDisplay | undefined;
}) {
	return (
		<For each={props.entries}>
			{(entry) => <PiTimelineEntryView entry={entry} character={props.character} />}
		</For>
	);
}


export function ConversationPanel(props: { character: CharacterDisplay | undefined }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const view = useConversationViewWorkflow(store, () => props.character);
	const { sceneTitle, streamedContent, hasThreadContent } = view;
	let threadRef: HTMLElement | undefined;

	createEffect(() => {
		// Track the active projection so the thread follows new timeline entries.
		void store.activePiTimeline?.entries.length;
		const el = threadRef;
		if (el) el.scrollTop = el.scrollHeight;
	});

	createEffect(() => {
		// "定位到对话" (plan §5.2): scroll and focus the source message and its
		// action line without changing the open result selection.
		const onLocate = (event: Event) => {
			const detail = (event as CustomEvent<ResultLocateDetail>).detail;
			if (!detail || detail.conversationId !== store.activeConversationId) return;
			const target = document.querySelector<HTMLElement>(`[data-pi-entry-id="${detail.messageId}"]`);
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

				<Show when={hasThreadContent()}>
					<Show when={store.activePiTimeline}>
						{(timeline) => (
							<PiTimelineRenderer
								entries={timeline().entries}
								character={props.character}
							/>
						)}
					</Show>
					<Show when={store.pendingUserText}>
						{(text) => (
							<article class="msg user optimistic-message" aria-label={t("messages.userMeta")}>
								<div class="msg-meta">{t("messages.userMeta")}</div>
								<p>{text()}</p>
							</article>
						)}
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
