import { i18n, useTranslation } from "@bear-harness/i18n";
import {
	faArrowUp,
	faFile,
	faFolderOpen,
	faPaperclip,
	faStop,
} from "@fortawesome/free-solid-svg-icons";
import { createSignal, Show } from "solid-js";
import { ModelSelector } from "./features/ModelSelector.js";
import { Icon } from "./Icon.js";
import { useCompanionStore } from "./stores/companion.js";
import { useConversationWorkflow } from "./stores/conversation-workflows.js";
import { Button, TextField } from "./ui/primitives.js";

type LocalFiles = {
	pickFiles(): Promise<string[]>;
	pickFolder(): Promise<string[]>;
	pathsForDroppedFiles(files: File[]): string[];
};
const localFiles = () =>
	(globalThis as typeof globalThis & { bearDesktop?: { localFiles?: LocalFiles } }).bearDesktop
		?.localFiles;

export function Composer(props: { placeholder: string; onOpenModelSettings?: () => void }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = useConversationWorkflow(store);
	const [menuOpen, setMenuOpen] = createSignal(false);
	const [pathError, setPathError] = createSignal<string | null>(null);
	const [dragging, setDragging] = createSignal(false);

	const pick = async (folder: boolean) => {
		setMenuOpen(false);
		setPathError(null);
		const bridge = localFiles();
		if (!bridge) {
			setPathError(t("composer.webDevPathHint"));
			return;
		}
		try {
			workflow.insertLocalPaths(
				folder ? await bridge.pickFolder() : await bridge.pickFiles(),
				folder ? t("composer.localFolderReference") : t("composer.localFileReference"),
			);
		} catch (error) {
			setPathError(error instanceof Error ? error.message : String(error));
		}
	};
	const drop = (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		const bridge = localFiles();
		const files = event.dataTransfer ? [...event.dataTransfer.files] : [];
		const paths = bridge?.pathsForDroppedFiles(files) ?? [];
		if (paths.length) workflow.insertLocalPaths(paths, t("composer.localFileReference"));
		else setPathError(t("composer.localPathOnly"));
	};
	return (
		<form
			class="composer"
			aria-label={t("composer.messageInputLabel")}
			data-drag-active={dragging() ? "true" : undefined}
			onSubmit={(event) => {
				event.preventDefault();
				void workflow.dispatchMessage();
			}}
			onDragEnter={(event) => {
				event.preventDefault();
				setDragging(true);
			}}
			onDragOver={(event) => event.preventDefault()}
			onDragLeave={() => setDragging(false)}
			onDrop={drop}
		>
			<ModelSelector
				models={workflow.models()}
				value={workflow.selectedModel()}
				class="composer-model"
				label={t("composer.modelLabel")}
				placeholder={t("composer.chooseModel")}
				labelClass="sr-only"
				disabled={
					workflow.modelBusy() || !store.activeConversationId || workflow.models().length === 0
				}
				triggerClass="composer-model-trigger"
				contentClass="composer-model-content"
				listClass="composer-model-list"
				itemClass="composer-model-item"
				placement="top-start"
				gutter={8}
				onModelChange={(model) => void workflow.selectModel(model)}
			/>
			<div class="composer-attach-menu">
				<Button
					type="button"
					class="circle"
					aria-label={t("composer.attachLabel")}
					onClick={() => setMenuOpen((open) => !open)}
				>
					<Icon icon={faPaperclip} />
				</Button>
				<Show when={menuOpen()}>
					<div class="composer-attach-options" role="menu">
						<Button type="button" role="menuitem" onClick={() => void pick(false)}>
							<Icon icon={faFile} />
							{t("composer.uploadFile")}
						</Button>
						<Button type="button" role="menuitem" onClick={() => void pick(true)}>
							<Icon icon={faFolderOpen} />
							{t("composer.uploadFolder")}
						</Button>
					</div>
				</Show>
			</div>
			<TextField class="composer-input">
				<TextField.TextArea
					rows={1}
					placeholder={props.placeholder}
					aria-label={t("composer.messageInputLabel")}
					value={workflow.composerText()}
					onInput={(event) => workflow.setComposerText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
							event.preventDefault();
							void workflow.dispatchMessage();
						}
					}}
					disabled={!store.activeConversationId || !workflow.modelSelected()}
				/>
			</TextField>
			<Show when={pathError()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<Show
				when={workflow.streaming()}
				fallback={
					<Button
						type="submit"
						class="send"
						aria-label={t("composer.sendLabel")}
						disabled={
							!store.activeConversationId ||
							!workflow.modelSelected() ||
							workflow.modelBusy() ||
							!workflow.composerText().trim()
						}
					>
						<Icon icon={faArrowUp} />
					</Button>
				}
			>
				<Button
					type="button"
					class="send"
					aria-label={t("composer.stopLabel")}
					onClick={() => void store.abort()}
				>
					<Icon icon={faStop} />
				</Button>
			</Show>
		</form>
	);
}
