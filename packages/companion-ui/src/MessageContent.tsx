import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { Marked, type Tokens } from "marked";
import { markedHighlight } from "marked-highlight";
import { createMemo, onCleanup, onMount, Show } from "solid-js";
import markedKatex from "./lib/marked-katex.js";

export interface MessageContentProps {
	text: string;
	format: "markdown" | "plain";
	streaming?: boolean;
	codeCopyLabel?: string;
	codeCopiedLabel?: string;
	copiedCodeIndex?: number;
	onCopyCode?(code: string, index: number): void;
}

const LARGE_STREAM_PLAIN_TEXT_THRESHOLD = 16_384;

const markdown = new Marked(
	{
		gfm: true,
		breaks: true,
		renderer: {
			// Character output is text, not trusted HTML. Raw model HTML is removed;
			// generated Markdown/KaTeX markup is sanitized after parsing below.
			html(_token: Tokens.HTML | Tokens.Tag) {
				return "";
			},
			image({ text }: Tokens.Image) {
				// Remote Markdown images would bypass Bear's declared host_media path.
				return DOMPurify.sanitize(text, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
			},
		},
	},
	markedHighlight({
		emptyLangClass: "hljs",
		langPrefix: "hljs language-",
		highlight(code, language) {
			const supported = language && hljs.getLanguage(language) ? language : "plaintext";
			return hljs.highlight(code, { language: supported }).value;
		},
	}),
	markedKatex({ throwOnError: false, strict: "warn" }),
);

interface CodeActions {
	copyLabel: string;
	copiedLabel: string;
	copiedIndex(): number | undefined;
}

export function renderMarkdown(text: string, codeActions?: CodeActions): string {
	const rendered = markdown.parse(text, { async: false });
	const sanitized = DOMPurify.sanitize(rendered, {
		USE_PROFILES: { html: true, mathMl: true, svg: true },
		FORBID_TAGS: ["button", "embed", "form", "iframe", "input", "object", "select", "textarea"],
	});
	if (typeof document === "undefined") return sanitized;
	const template = document.createElement("template");
	template.innerHTML = sanitized;
	for (const link of template.content.querySelectorAll("a")) {
		const href = link.getAttribute("href");
		if (!href?.startsWith("https://")) link.removeAttribute("href");
		else {
			link.target = "_blank";
			link.rel = "noopener noreferrer";
		}
	}
	if (!codeActions) return template.innerHTML;
	for (const [index, block] of [...template.content.querySelectorAll("pre")].entries()) {
		const code = block.querySelector("code");
		if (!code) continue;
		const container = document.createElement("div");
		container.className = "message-code-block";
		const toolbar = document.createElement("div");
		toolbar.className = "message-code-toolbar";
		const language = [...code.classList]
			.find((name) => name.startsWith("language-"))
			?.slice("language-".length);
		const label = document.createElement("span");
		label.className = "message-code-language";
		label.textContent = language ?? "code";
		const button = document.createElement("button");
		button.type = "button";
		button.className = "message-code-copy";
		button.dataset.codeIndex = String(index);
		button.textContent =
			codeActions.copiedIndex() === index ? codeActions.copiedLabel : codeActions.copyLabel;
		button.setAttribute("aria-label", button.textContent);
		toolbar.append(label, button);
		block.before(container);
		container.append(toolbar, block);
	}
	return template.innerHTML;
}

/** Pure projection: all content and lifecycle state come from reactive props. */
export function MessageContent(props: MessageContentProps) {
	let contentRef: HTMLDivElement | undefined;
	// Preserve the upstream string identity across equivalent snapshot objects.
	// This is a derived reference, not a second message or mutable component state.
	const text = createMemo(() => props.text);
	const renderLargeStreamAsPlainText = createMemo(
		() => props.streaming === true && text().length > LARGE_STREAM_PLAIN_TEXT_THRESHOLD,
	);
	const rendered = createMemo(() =>
		renderLargeStreamAsPlainText()
			? ""
			: renderMarkdown(
					text(),
					props.onCopyCode && props.codeCopyLabel && props.codeCopiedLabel
						? {
								copyLabel: props.codeCopyLabel,
								copiedLabel: props.codeCopiedLabel,
								copiedIndex: () => props.copiedCodeIndex,
							}
						: undefined,
				),
	);
	const copyCode = (event: Event) => {
		if (!props.onCopyCode || !contentRef || !(event.target instanceof Element)) return;
		const button = event.target.closest<HTMLButtonElement>("button[data-code-index]");
		if (!button || !contentRef.contains(button)) return;
		const index = Number(button.dataset.codeIndex);
		const code = contentRef.querySelectorAll("pre code").item(index)?.textContent;
		if (Number.isInteger(index) && code !== undefined) props.onCopyCode(code, index);
	};
	onMount(() => contentRef?.addEventListener("click", copyCode));
	onCleanup(() => contentRef?.removeEventListener("click", copyCode));
	return (
		<div
			class="message-content"
			data-testid="message-content"
			classList={{ "is-streaming": props.streaming === true }}
			aria-busy={props.streaming === true ? "true" : undefined}
		>
			<Show when={props.format === "markdown"} fallback={<p>{text()}</p>}>
				<Show
					when={!renderLargeStreamAsPlainText()}
					fallback={
						<p class="message-streaming-plain" data-testid="message-streaming-plain">
							{text()}
						</p>
					}
				>
					<div
						ref={contentRef}
						class="message-markdown"
						data-testid="message-markdown"
						innerHTML={rendered()}
					/>
				</Show>
			</Show>
		</div>
	);
}
