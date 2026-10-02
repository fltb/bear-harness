import { i18n, useTranslation } from "@bear-harness/i18n";
import type { CharacterDraft, ConversationDetail, PiAgentMessage } from "@bear-harness/protocol";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { parseDocument } from "yaml";
import { hostChoices, hostToolPayload } from "../../lib/host-tool-presentation.js";
import { renderMarkdown } from "../../MessageContent.js";
import type { CharacterApi } from "../../stores/supplementary-api.js";
import { Button, Dialog, TextField } from "../../ui/primitives.js";
import { DraftPreview } from "./DraftPreview.js";
import { EditorSelect } from "./SchemaFields.js";

export function StudioTrial(props: {
	api: CharacterApi;
	draft: CharacterDraft;
	source?: string;
	models: Array<{ providerId: string; modelId: string; label: string }>;
	onClose(): void;
	onOpenSettings?(): void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const [mediaPreview, setMediaPreview] = createSignal<{ asset: string; captions?: string }>();
	const media = createMemo(() => {
		const doc = parseDocument(props.source ?? "{}");
		const items: unknown = doc.errors.length ? [] : doc.toJS()?.media;
		return Array.isArray(items)
			? (items as Array<{ id: string; label: string; asset: string; captions?: string }>)
			: [];
	});
	const payload = (message: PiAgentMessage) =>
		message.role === "toolResult" ? hostToolPayload(message.details) : undefined;
	const choices = (message: PiAgentMessage) =>
		message.role === "toolResult" && message.toolName === "host_choices"
			? hostChoices(payload(message))
			: undefined;
	const selectedMedia = (message: PiAgentMessage) =>
		message.role === "toolResult" && message.toolName === "host_media"
			? media().find((item) => item.id === payload(message)?.mediaId)
			: undefined;
	const [route, setRoute] = createSignal("");
	const [trialId, setTrialId] = createSignal<string>();
	const [detail, setDetail] = createSignal<ConversationDetail>();
	const [stream, setStream] = createSignal<PiAgentMessage>();
	const [streaming, setStreaming] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal("");
	const [text, setText] = createSignal("");
	const [connected, setConnected] = createSignal(false);
	const lifetime = new AbortController();
	let disposed = false;
	const modelKey = (model: { providerId: string; modelId: string }) =>
		`${model.providerId} / ${model.modelId}`;
	const selected = () =>
		props.models.find(
			(model) =>
				modelKey(model) === (route() || (props.models[0] ? modelKey(props.models[0]) : "")),
		);
	const apply = (next: ConversationDetail | undefined) => {
		if (!next) return;
		setDetail(next);
		setStreaming(next.live.isStreaming);
		setStream(next.live.streamingMessage);
	};
	const fail = (cause: unknown) =>
		setError(
			cause instanceof Error
				? cause.message
				: typeof cause === "object" && cause && "reason" in cause
					? String(cause.reason)
					: String(cause),
		);
	const act = async (operation: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await operation();
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	};
	const refresh = async () => {
		const id = trialId();
		if (id) {
			const next = await props.api.trial({ action: "get", trialId: id });
			if (trialId() === id && !disposed) apply(next.detail);
		}
	};
	async function listen() {
		try {
			const events = await props.api.trialEvents(lifetime.signal);
			setConnected(true);
			await refresh();
			for await (const event of events) {
				if (event.type !== "studioTrial" || event.trialId !== trialId()) continue;
				const native = event.event;
				if (native.type === "agent_start") setStreaming(true);
				if (native.type === "message_update") setStream(native.message);
				if (native.type === "message_end") {
					setStream(undefined);
					await refresh();
				}
				if (native.type === "agent_end") {
					setStreaming(false);
					setStream(undefined);
					await refresh();
				}
			}
		} catch (cause) {
			if (!disposed) fail(cause);
		} finally {
			setConnected(false);
		}
	}
	onMount(() => void listen());
	onCleanup(() => {
		disposed = true;
		lifetime.abort();
		const id = trialId();
		if (id) void props.api.trial({ action: "close", trialId: id }).catch(() => undefined);
	});
	async function send(sent: string) {
		const id = trialId();
		if (!id) return;
		const next = await props.api.trial({
			action: "send",
			trialId: id,
			text: sent,
			clientMessageId: crypto.randomUUID(),
		});
		if (text() === sent) setText("");
		apply(next.detail);
	}
	async function close() {
		const id = trialId();
		if (id) await props.api.trial({ action: "close", trialId: id });
		setTrialId(undefined);
		props.onClose();
	}
	async function start() {
		const model = selected();
		if (!model) return;
		const old = trialId();
		if (old) await props.api.trial({ action: "close", trialId: old });
		setTrialId(undefined);
		setDetail(undefined);
		setStream(undefined);
		const next = await props.api.trial({
			action: "start",
			id: props.draft.id,
			expectedRevision: props.draft.currentRevision,
			providerId: model.providerId,
			modelId: model.modelId,
		});
		if (disposed) {
			await props.api.trial({ action: "close", trialId: next.trialId });
			return;
		}
		setTrialId(next.trialId);
		apply(next.detail);
	}
	const messageText = (message: PiAgentMessage) => {
		if (!("content" in message)) return "";
		if (typeof message.content === "string") return message.content;
		return message.content
			.map((part) =>
				part.type === "text"
					? part.text
					: part.type === "toolCall"
						? `${part.name}\n${JSON.stringify(part.arguments, null, 2)}`
						: "",
			)
			.filter(Boolean)
			.join("\n\n");
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy()) void act(close);
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay class="confirmation-overlay" />
				<Dialog.Content class="studio-preview-dialog">
					<header class="studio-tools">
						<Dialog.Title>{t("studio.trial")}</Dialog.Title>
						<Dialog.CloseButton as={Button} disabled={busy()} aria-label={t("backstage.close")}>
							{t("backstage.close")}
						</Dialog.CloseButton>
					</header>
					<p>{t("studio.trialHint", { revision: props.draft.currentRevision })}</p>
					<div class="studio-tools">
						<EditorSelect
							label={t("studio.trialModel")}
							options={props.models.map(modelKey)}
							value={selected() ? modelKey(selected()!) : ""}
							onChange={setRoute}
							disabled={busy() || streaming()}
						/>
						<Button
							disabled={busy() || !selected() || !connected()}
							onClick={() => void act(start)}
						>
							{t(trialId() ? "studio.trialReset" : "studio.trialStart")}
						</Button>
					</div>
					<Show when={!props.models.length}>
						<p>{t("studio.trialNoModels")}</p>
						<Show when={props.onOpenSettings}>
							<Button onClick={() => props.onOpenSettings?.()}>
								{t("sidebar.systemSettings")}
							</Button>
						</Show>
					</Show>
					<Show when={!connected()}>
						<Button onClick={() => void listen()}>{t("studio.reconnect")}</Button>
					</Show>
					<Show when={error()}>
						<p role="alert">{error()}</p>
					</Show>
					<div class="studio-trial-messages" aria-live="polite">
						<For each={detail()?.branch.entries.filter((entry) => entry.type === "message") ?? []}>
							{(entry) => (
								<Show when={entry.type === "message" && entry.message}>
									{(message) => (
										<article>
											<strong>{message().role}</strong>
											<Show when={choices(message())}>
												{(value) => (
													<div class="studio-fields">
														<p>{value().prompt}</p>
														<div class="studio-tools">
															<For each={value().items}>
																{(choice) => (
																	<Button
																		disabled={busy() || streaming() || !connected()}
																		onClick={() => void act(() => send(choice.message))}
																	>
																		{choice.label}
																	</Button>
																)}
															</For>
														</div>
													</div>
												)}
											</Show>
											<Show when={selectedMedia(message())}>
												{(item) => (
													<Button onClick={() => setMediaPreview(item())}>{item().label}</Button>
												)}
											</Show>

											<div
												class="message-markdown"
												innerHTML={renderMarkdown(
													choices(message()) || selectedMedia(message())
														? ""
														: messageText(message()),
												)}
											/>
										</article>
									)}
								</Show>
							)}
						</For>
						<Show when={stream()}>
							{(message) => (
								<article
									class="message-markdown"
									innerHTML={renderMarkdown(messageText(message()))}
								/>
							)}
						</Show>
					</div>
					<Show when={detail()?.live.errorMessage}>
						<p role="alert">{detail()?.live.errorMessage}</p>
					</Show>
					<Show when={trialId()}>
						{(id) => (
							<form
								class="studio-fields"
								onSubmit={(event) => {
									event.preventDefault();
									void act(() => send(text()));
								}}
							>
								<TextField value={text()} onChange={setText}>
									<TextField.Label>{t("studio.trialMessage")}</TextField.Label>
									<TextField.TextArea rows={3} />
								</TextField>
								<div class="studio-tools">
									<Button
										type="submit"
										disabled={busy() || streaming() || !text().trim() || !connected()}
									>
										{t("studio.trialSend")}
									</Button>
									<Button
										disabled={!streaming() || busy()}
										onClick={() =>
											void act(async () => {
												apply((await props.api.trial({ action: "abort", trialId: id() })).detail);
											})
										}
									>
										{t("studio.trialStop")}
									</Button>
								</div>
							</form>
						)}
					</Show>
				</Dialog.Content>
				<Show when={mediaPreview()}>
					{(item) => (
						<DraftPreview
							api={props.api}
							id={props.draft.id}
							files={props.draft.files}
							source={props.source ?? "{}"}
							file={item().asset}
							captions={item().captions}
							onClose={() => setMediaPreview(undefined)}
						/>
					)}
				</Show>
			</Dialog.Portal>
		</Dialog>
	);
}
