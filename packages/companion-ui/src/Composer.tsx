import { productUi } from "@bear-harness/product-config";
import { createSignal } from "solid-js";
import { useCompanionStore } from "./stores/companion.js";

/**
 * Composer: live input wired to `message.send`. Enter sends, Shift+Enter
 * inserts a newline. The attach button is a placeholder: the materials
 * pipeline is not part of the bridge yet, so it stays disabled with an
 * explanatory label instead of pretending to work.
 */
export function Composer(props: { placeholder: string }) {
	const store = useCompanionStore();
	const [text, setText] = createSignal("");

	const send = (event: SubmitEvent) => {
		event.preventDefault();
		const value = text().trim();
		if (!value) return;
		setText("");
		void store.sendMessage(value);
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
			<button
				type="button"
				class="circle"
				disabled
				aria-label={productUi.composer.attachUnavailableLabel}
				title={productUi.composer.attachUnavailableTitle}
			>
				＋
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
				disabled={store.activeConversationId === null || text().trim().length === 0}
			>
				➤
			</button>
		</form>
	);
}
