import { i18n, useTranslation } from "@bear-harness/i18n";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { MessageContent } from "./MessageContent.js";

export function nativeRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Native signatures are opaque provider state, never public message content. */
export function nativeSource(value: unknown): string {
	return (
		JSON.stringify(
			value,
			(key, item: unknown) =>
				/^(?:signature|thinkingSignature|textSignature|thoughtSignature|encrypted_content)$/i.test(
					key,
				)
					? undefined
					: item,
			2,
		) ?? ""
	);
}

function NativePart(props: { part: unknown; format: "plain" | "markdown"; streaming?: boolean }) {
	const [t] = useTranslation(undefined, { i18n });
	const [imageFailed, setImageFailed] = createSignal(false);
	const part = () => nativeRecord(props.part);
	const type = () => part()?.type;
	const image = () => {
		const value = part();
		if (!value || typeof value.data !== "string" || typeof value.mimeType !== "string") return;
		if (
			!/^image\/(?:png|jpeg|gif|webp)$/.test(value.mimeType) ||
			!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(value.data)
		)
			return;
		return `data:${value.mimeType};base64,${value.data}`;
	};
	return (
		<Switch
			fallback={
				<div class="native-content-fallback">
					<p>{t("messages.native.unsupported")}</p>
					<details>
						<summary>{t("messages.native.source")}</summary>
						<pre>{nativeSource(props.part)}</pre>
					</details>
				</div>
			}
		>
			<Match when={type() === "toolCall" || type() === "redactedThinking"}>{null}</Match>
			<Match when={type() === "text" && typeof part()?.text === "string"}>
				<MessageContent
					text={part()?.text as string}
					format={props.format}
					streaming={props.streaming}
				/>
			</Match>
			<Match when={type() === "thinking"}>
				<Show
					when={
						part()?.redacted !== true &&
						typeof part()?.thinking === "string" &&
						part()?.thinking !== ""
					}
				>
					<details>
						<summary>{t("messages.native.thinking")}</summary>
						<MessageContent text={part()?.thinking as string} format="plain" />
					</details>
				</Show>
			</Match>
			<Match when={type() === "image"}>
				<Show
					when={!imageFailed() && image()}
					fallback={
						<div>
							<p>{t("messages.native.blockedImage")}</p>
							<details>
								<summary>{t("messages.native.source")}</summary>
								<pre>{nativeSource(props.part)}</pre>
							</details>
						</div>
					}
				>
					{(src) => (
						<img
							class="native-message-image"
							src={src()}
							alt={t("messages.native.image")}
							loading="lazy"
							onError={() => setImageFailed(true)}
						/>
					)}
				</Show>
			</Match>
		</Switch>
	);
}

/** Shared for live and persisted Pi content. No remote image loading or raw HTML. */
export function NativeMessageContent(props: {
	content: unknown;
	format?: "plain" | "markdown";
	streaming?: boolean;
}) {
	return (
		<Show
			when={typeof props.content !== "string"}
			fallback={
				<MessageContent
					text={props.content as string}
					format={props.format ?? "markdown"}
					streaming={props.streaming}
				/>
			}
		>
			<Show
				when={Array.isArray(props.content)}
				fallback={
					<Show when={props.content != null}>
						<NativePart
							part={props.content}
							format={props.format ?? "markdown"}
							streaming={props.streaming}
						/>
					</Show>
				}
			>
				<For each={props.content as unknown[]}>
					{(part) => (
						<NativePart
							part={part}
							format={props.format ?? "markdown"}
							streaming={props.streaming}
						/>
					)}
				</For>
			</Show>
		</Show>
	);
}
