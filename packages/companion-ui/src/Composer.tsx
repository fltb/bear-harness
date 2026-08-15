import { productUi } from "@bear-harness/product-config";
import { createSignal, Show } from "solid-js";
import { useCompanionStore } from "./stores/companion.js";

/**
 * Composer: live input wired to `message.send`. Enter sends, Shift+Enter
 * inserts a newline. Small text-based materials are read locally and sent
 * with the next message; binary documents use the Host material workflow.
 */
export function Composer(props: { placeholder: string }) {
	const store = useCompanionStore();
	const [text, setText] = createSignal("");
	const [attachments, setAttachments] = createSignal<Array<{ name: string; content: string }>>([]);
	let fileInput: HTMLInputElement | undefined;

	const send = (event: SubmitEvent) => {
		event.preventDefault();
		const value = text().trim();
		if (!value && attachments().length === 0) return;
		const materials = attachments()
			.map((file) => `\n\n[${productUi.composer.materialLabel}：${file.name}]\n${file.content}`)
			.join("");
		setText("");
		setAttachments([]);
		void store.sendMessage(`${value}${materials}`.trim());
	};

	const chooseFiles = async (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])].slice(0, 10);
		const loaded: Array<{ name: string; content: string }> = [];
		for (const file of files) {
			if (file.size > 10 * 1024 * 1024) continue;
			loaded.push({ name: file.name, content: await file.text() });
		}
		setAttachments(loaded);
		input.value = "";
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			const form = (event.currentTarget as HTMLTextAreaElement | null)?.form;
			form?.requestSubmit();
		}
	};

	return (
		<form class="composer" onSubmit={send}>
			<input
				ref={(element) => {
					fileInput = element;
				}}
				class="material-picker"
				type="file"
				aria-label={productUi.composer.attachTitle}
				multiple
				accept="text/*,.md,.markdown,.json,.csv,.yaml,.yml,.toml,.xml,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.sql"
				onChange={(event) => void chooseFiles(event)}
			/>
			<button
				type="button"
				class="circle"
				aria-label={productUi.composer.attachLabel}
				title={productUi.composer.attachTitle}
				onClick={() => fileInput?.click()}
			>
				<Show when={attachments().length > 0} fallback="＋">
					{attachments().length}
				</Show>
			</button>
			<textarea
				rows={1}
				placeholder={props.placeholder}
				aria-label={productUi.composer.messageInputLabel}
				value={text()}
				onInput={(event) => setText(event.currentTarget.value)}
				onKeyDown={handleKeyDown}
				disabled={store.activeConversationId === null}
			/>
			<button
				type="submit"
				class="send"
				aria-label={productUi.composer.sendLabel}
				disabled={
					store.activeConversationId === null ||
					(text().trim().length === 0 && attachments().length === 0)
				}
			>
				➤
			</button>
		</form>
	);
}
