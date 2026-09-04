import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { Marked, type Tokens } from "marked";
import { markedHighlight } from "marked-highlight";
import { Show } from "solid-js";
import markedKatex from "./lib/marked-katex.js";

export interface MessageContentProps {
	text: string;
	format: "markdown" | "plain";
	streaming?: boolean;
}

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

export function renderMarkdown(text: string): string {
	const rendered = markdown.parse(text, { async: false });
	return DOMPurify.sanitize(rendered, {
		USE_PROFILES: { html: true, mathMl: true, svg: true },
		FORBID_TAGS: ["button", "embed", "form", "iframe", "input", "object", "select", "textarea"],
	});
}

/** Pure projection: all content and lifecycle state come from reactive props. */
export function MessageContent(props: MessageContentProps) {
	return (
		<div
			class="message-content"
			data-testid="message-content"
			classList={{ "is-streaming": props.streaming === true }}
			aria-busy={props.streaming === true ? "true" : undefined}
		>
			<Show when={props.format === "markdown"} fallback={<p>{props.text}</p>}>
				<div class="message-markdown" innerHTML={renderMarkdown(props.text)} />
			</Show>
		</div>
	);
}
