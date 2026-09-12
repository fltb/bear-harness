import { i18n, useTranslation } from "@bear-harness/i18n";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { MessageContent } from "./MessageContent.js";

export function nativeRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

const privateNativeKeys = new Set([
	"signature",
	"thinkingsignature",
	"textsignature",
	"thoughtsignature",
	"encrypted_content",
]);

/** Native signatures are opaque provider state, never public message content. */
export function nativeSource(value: unknown): string {
	const source =
		JSON.stringify(
			value,
			(key, item: unknown) => {
				if (privateNativeKeys.has(key.toLocaleLowerCase())) return undefined;
				if (key === "data" && typeof item === "string")
					return `[binary data omitted: ${item.length} characters]`;
				if (typeof item === "string" && item.length > 4_096)
					return `${item.slice(0, 4_096)}… [truncated: ${item.length} characters total]`;
				return item;
			},
			2,
		) ?? "";
	return source.length <= 32_768
		? source
		: `${source.slice(0, 32_768)}\n… [native source truncated]`;
}

type CopiedCode = { partIndex: number; codeIndex: number };

function NativePart(props: {
	part: unknown;
	partIndex: number;
	format: "plain" | "markdown";
	streaming?: boolean;
	codeCopyLabel?: string;
	codeCopiedLabel?: string;
	copiedCode?: CopiedCode;
	onCopyCode?(code: string, partIndex: number, codeIndex: number): void;
}) {
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
					codeCopyLabel={props.codeCopyLabel}
					codeCopiedLabel={props.codeCopiedLabel}
					copiedCodeIndex={
						props.copiedCode?.partIndex === props.partIndex ? props.copiedCode.codeIndex : undefined
					}
					onCopyCode={
						props.onCopyCode
							? (code, codeIndex) => props.onCopyCode?.(code, props.partIndex, codeIndex)
							: undefined
					}
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
					<details class="native-thinking">
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
	codeCopyLabel?: string;
	codeCopiedLabel?: string;
	copiedCode?: CopiedCode;
	onCopyCode?(code: string, partIndex: number, codeIndex: number): void;
}) {
	return (
		<Show
			when={typeof props.content !== "string"}
			fallback={
				<MessageContent
					text={props.content as string}
					format={props.format ?? "markdown"}
					streaming={props.streaming}
					codeCopyLabel={props.codeCopyLabel}
					codeCopiedLabel={props.codeCopiedLabel}
					copiedCodeIndex={
						props.copiedCode?.partIndex === 0 ? props.copiedCode.codeIndex : undefined
					}
					onCopyCode={
						props.onCopyCode
							? (code, codeIndex) => props.onCopyCode?.(code, 0, codeIndex)
							: undefined
					}
				/>
			}
		>
			<Show
				when={Array.isArray(props.content)}
				fallback={
					<Show when={props.content != null}>
						<NativePart
							part={props.content}
							partIndex={0}
							format={props.format ?? "markdown"}
							streaming={props.streaming}
							codeCopyLabel={props.codeCopyLabel}
							codeCopiedLabel={props.codeCopiedLabel}
							copiedCode={props.copiedCode}
							onCopyCode={props.onCopyCode}
						/>
					</Show>
				}
			>
				<For each={props.content as unknown[]}>
					{(part, partIndex) => (
						<NativePart
							part={part}
							partIndex={partIndex()}
							format={props.format ?? "markdown"}
							streaming={props.streaming}
							codeCopyLabel={props.codeCopyLabel}
							codeCopiedLabel={props.codeCopiedLabel}
							copiedCode={props.copiedCode}
							onCopyCode={props.onCopyCode}
						/>
					)}
				</For>
			</Show>
		</Show>
	);
}
