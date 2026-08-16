import { createEffect, createSignal, For, Show } from "solid-js";
import { t } from "./i18n.js";
import { useCompanionStore } from "./stores/companion.js";

type ComposerAttachment =
	| { kind: "text"; name: string; content: string }
	| { kind: "image"; name: string; mime: string; base64: string };

/**
 * Composer: live input wired to `message.send`. Enter sends, Shift+Enter
 * inserts a newline. Small text-based materials are read locally and sent
 * with the next message; binary documents use the Host material workflow.
 */
export function Composer(props: { placeholder: string }) {
	const store = useCompanionStore();
	const [text, setText] = createSignal("");
	const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
	const modelSelected = () => store.model.selectedValue().length > 0;
	let fileInput: HTMLInputElement | undefined;

	createEffect(() => {
		const conversationId = store.activeConversationId;
		if (conversationId) void store.model.list(conversationId);
	});

	const send = (event: SubmitEvent) => {
		event.preventDefault();
		const value = text().trim();
		if (!value && attachments().length === 0) return;
		const materials = attachments()
			.filter((file): file is Extract<ComposerAttachment, { kind: "text" }> => file.kind === "text")
			.map((file) => `\n\n[${t("composer.materialLabel")}：${file.name}]\n${file.content}`)
			.join("");
		const images = attachments()
			.filter((file) => file.kind === "image")
			.map((file) => ({ name: file.name, mime: file.mime, base64: file.base64 }));
		const message =
			`${value}${materials}`.trim() ||
			images.map((image) => `[${t("composer.imageLabel")}：${image.name}]`).join("\n");
		setText("");
		setAttachments([]);
		void store.sendMessage(message, images.length > 0 ? images : undefined);
	};

	const chooseFiles = async (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])].slice(0, 10);
		const loaded: ComposerAttachment[] = [];
		for (const file of files) {
			if (file.size > 10 * 1024 * 1024) continue;
			if (file.type.startsWith("image/")) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = "";
				for (const byte of bytes) binary += String.fromCharCode(byte);
				loaded.push({ kind: "image", name: file.name, mime: file.type, base64: btoa(binary) });
			} else {
				loaded.push({ kind: "text", name: file.name, content: await file.text() });
			}
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
			<label class="composer-model">
				<span class="sr-only">{t("composer.modelLabel")}</span>
				<select
					aria-label={t("composer.modelLabel")}
					value={store.model.selectedValue()}
					disabled={store.activeConversationId === null || store.model.models().length === 0}
					onInput={(event) => {
						const conversationId = store.activeConversationId;
						const [providerId, modelId] = event.currentTarget.value.split(":", 2);
						if (conversationId && providerId && modelId)
							void store.model.select(conversationId, providerId, modelId);
					}}
				>
					<Show when={store.model.models().length > 0}>
						<option value="" disabled>
							{t("composer.chooseModel")}
						</option>
					</Show>
					<Show
						when={store.model.models().length > 0}
						fallback={<option value="">{t("composer.noModel")}</option>}
					>
						<For each={store.model.models()}>
							{(model) => (
								<option value={`${model.providerId}:${model.modelId}`}>{model.label}</option>
							)}
						</For>
					</Show>
				</select>
			</label>
			<input
				ref={(element) => {
					fileInput = element;
				}}
				class="material-picker"
				type="file"
				aria-label={t("composer.attachTitle")}
				disabled={!modelSelected()}
				multiple
				accept="image/*,text/*,.md,.markdown,.json,.csv,.yaml,.yml,.toml,.xml,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.sql"
				onChange={(event) => void chooseFiles(event)}
			/>
			<button
				type="button"
				class="circle"
				aria-label={t("composer.attachLabel")}
				title={t("composer.attachTitle")}
				disabled={!modelSelected()}
				onClick={() => fileInput?.click()}
			>
				<Show when={attachments().length > 0} fallback="＋">
					{attachments().length}
				</Show>
			</button>
			<textarea
				rows={1}
				placeholder={props.placeholder}
				aria-label={t("composer.messageInputLabel")}
				value={text()}
				onInput={(event) => setText(event.currentTarget.value)}
				onKeyDown={handleKeyDown}
				disabled={store.activeConversationId === null || !modelSelected()}
			/>
			<button
				type="submit"
				class="send"
				aria-label={t("composer.sendLabel")}
				disabled={
					store.activeConversationId === null ||
					!modelSelected() ||
					(text().trim().length === 0 && attachments().length === 0)
				}
			>
				➤
			</button>
		</form>
	);
}
