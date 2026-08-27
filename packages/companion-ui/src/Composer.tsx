import { i18n, useTranslation } from "@bear-harness/i18n";
import { faArrowUp, faPaperclip, faStop } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kobalte/core/button";
import { FileField } from "@kobalte/core/file-field";
import { TextField } from "@kobalte/core/text-field";
import { createMutation } from "@tanstack/solid-query";
import { createSignal, For, Show } from "solid-js";
import { ModelSelector } from "./features/ModelSelector.js";
import { Icon } from "./Icon.js";
import { useCompanionStore } from "./stores/companion.js";
import { useConversationWorkflow } from "./stores/conversation-workflows.js";

type Summary = {
	id: string;
	name: string;
	kind: "file" | "folder" | "generated";
	bytes: number;
	fileCount: number;
};
type DesktopAttachments = {
	pickFiles(id: string): Promise<Summary[]>;
	pickFolder(id: string): Promise<Summary[]>;
	importDroppedFiles(id: string, files: File[]): Promise<Summary[]>;
};
const desktopAttachments = () =>
	(globalThis as typeof globalThis & { bearDesktop?: { attachments?: DesktopAttachments } })
		.bearDesktop?.attachments;

type DroppedHandle = {
	kind: "file" | "directory";
	name: string;
	getFile?: () => Promise<File>;
	values?: () => AsyncIterable<DroppedHandle>;
};
type WebkitEntry = {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?: (success: (file: File) => void, failure: (error: DOMException) => void) => void;
	createReader?: () => {
		readEntries(
			success: (entries: WebkitEntry[]) => void,
			failure: (error: DOMException) => void,
		): void;
	};
};

async function enumerateHandle(
	handle: DroppedHandle,
	prefix = "",
): Promise<Array<{ file: File; relativePath: string }>> {
	if (handle.kind === "file" && handle.getFile) {
		const file = await handle.getFile();
		return [{ file, relativePath: `${prefix}${file.name}` }];
	}
	const files: Array<{ file: File; relativePath: string }> = [];
	if (handle.kind === "directory" && handle.values) {
		for await (const child of handle.values()) {
			files.push(
				...(await enumerateHandle(
					child,
					`${prefix}${child.kind === "directory" ? `${child.name}/` : ""}`,
				)),
			);
		}
	}
	return files;
}

function webkitFile(entry: WebkitEntry): Promise<File> {
	// WebKit's callback-only FileSystemEntry API requires an executor bridge.
	return new Promise((resolve, reject) => entry.file?.(resolve, reject));
}

async function enumerateWebkitEntry(
	entry: WebkitEntry,
	prefix = "",
): Promise<Array<{ file: File; relativePath: string }>> {
	if (entry.isFile) {
		const file = await webkitFile(entry);
		return [{ file, relativePath: `${prefix}${file.name}` }];
	}
	const reader = entry.createReader?.();
	if (!entry.isDirectory || !reader) return [];
	const children: WebkitEntry[] = [];
	for (;;) {
		// WebKit exposes directory pages only through callbacks.
		const page = await new Promise<WebkitEntry[]>((resolve, reject) =>
			reader.readEntries(resolve, reject),
		);
		if (page.length === 0) break;
		children.push(...page);
	}
	const files: Array<{ file: File; relativePath: string }> = [];
	for (const child of children) {
		files.push(
			...(await enumerateWebkitEntry(
				child,
				`${prefix}${child.isDirectory ? `${child.name}/` : ""}`,
			)),
		);
	}
	return files;
}

export function folderFiles(
	files: readonly File[],
): Array<{ name: string; files: Array<{ file: File; relativePath: string }> }> {
	const roots = new Map<string, Array<{ file: File; relativePath: string }>>();
	for (const file of files) {
		const path = (
			(file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
		).replaceAll("\\", "/");
		const [root, ...parts] = path.split("/");
		if (!root) continue;
		const group = roots.get(root) ?? [];
		group.push({ file, relativePath: parts.join("/") || file.name });
		roots.set(root, group);
	}
	return [...roots].map(([name, grouped]) => ({ name, files: grouped }));
}

export function Composer(props: { placeholder: string; onOpenModelSettings?: () => void }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = useConversationWorkflow(store);
	const nativeImport = createMutation(() => ({
		mutationFn: (action: () => Promise<Summary[]>) => action(),
		retry: false,
		gcTime: 0,
	}));
	const [menuOpen, setMenuOpen] = createSignal(false);
	const [dragging, setDragging] = createSignal(false);
	let fileInput: HTMLInputElement | undefined;
	let folderInput: HTMLInputElement | undefined;

	const pick = async (folder: boolean) => {
		setMenuOpen(false);
		const id = store.activeConversationId;
		const bridge = desktopAttachments();
		try {
			if (id && bridge)
				await workflow.addCompletedAttachments(
					await nativeImport.mutateAsync(() =>
						folder ? bridge.pickFolder(id) : bridge.pickFiles(id),
					),
					id,
				);
			else (folder ? folderInput : fileInput)?.click();
		} catch (error) {
			workflow.setAttachmentError(error instanceof Error ? error.message : String(error));
		}
	};
	const drop = async (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		const id = store.activeConversationId;
		const transfer = event.dataTransfer;
		if (!id || !transfer) return;
		try {
			const bridge = desktopAttachments();
			if (bridge) {
				await workflow.addCompletedAttachments(
					await nativeImport.mutateAsync(() => bridge.importDroppedFiles(id, [...transfer.files])),
					id,
				);
				return;
			}
			const regularFiles: File[] = [];
			let enumerated = false;
			for (const item of [...transfer.items]) {
				const extended = item as DataTransferItem & {
					getAsFileSystemHandle?: () => Promise<DroppedHandle | null>;
					webkitGetAsEntry?: () => WebkitEntry | null;
				};
				const handle = await extended.getAsFileSystemHandle?.();
				if (handle) {
					enumerated = true;
					if (handle.kind === "directory") {
						await workflow.loadFolderFiles(handle.name, await enumerateHandle(handle));
					} else if (handle.getFile) {
						regularFiles.push(await handle.getFile());
					}
					continue;
				}
				const entry = extended.webkitGetAsEntry?.();
				if (!entry) continue;
				enumerated = true;
				if (entry.isDirectory) {
					await workflow.loadFolderFiles(entry.name, await enumerateWebkitEntry(entry));
				} else if (entry.isFile) {
					regularFiles.push(await webkitFile(entry));
				}
			}
			if (regularFiles.length > 0) await workflow.loadFiles(regularFiles);
			else if (!enumerated) await workflow.loadFiles([...transfer.files]);
		} catch (error) {
			workflow.setAttachmentError(error instanceof Error ? error.message : String(error));
		}
	};
	return (
		<form
			class="composer"
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
			onDrop={(event) => void drop(event)}
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
			<FileField multiple>
				<FileField.HiddenInput
					ref={fileInput}
					class="material-picker"
					aria-label={t("composer.uploadFile")}
					onChange={(event) => {
						void workflow.loadFiles([...(event.currentTarget.files ?? [])]);
						event.currentTarget.value = "";
					}}
				/>
			</FileField>
			<FileField multiple>
				<FileField.HiddenInput
					ref={(element) => {
						folderInput = element;
						element.setAttribute("webkitdirectory", "");
					}}
					class="material-picker"
					aria-label={t("composer.uploadFolder")}
					onChange={(event) => {
						for (const root of folderFiles([...(event.currentTarget.files ?? [])]))
							void workflow.loadFolderFiles(root.name, root.files);
						event.currentTarget.value = "";
					}}
				/>
			</FileField>
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
							{t("composer.uploadFile")}
						</Button>
						<Button type="button" role="menuitem" onClick={() => void pick(true)}>
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
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					disabled={!store.activeConversationId || !workflow.modelSelected()}
				/>
			</TextField>
			<Show when={workflow.attachments().length}>
				<ul class="composer-attachment-tray" aria-label={t("attachments.listLabel")}>
					<For each={workflow.attachments()}>
						{(item) => (
							<li class="composer-attachment-draft" data-upload-state={item.uploadState}>
								<strong>{item.name}</strong>
								<span>
									{item.uploadState === "uploading"
										? `${Math.round(item.progress * 100)}%`
										: item.uploadState}
								</span>
								<Show when={item.uploadState === "error" || item.uploadState === "cancelled"}>
									<Button type="button" onClick={() => workflow.retryAttachment(item.draftId)}>
										Retry
									</Button>
								</Show>
								<Button
									type="button"
									aria-label={`Remove ${item.name}`}
									onClick={() => void workflow.removeAttachment(item.draftId)}
								>
									×
								</Button>
							</li>
						)}
					</For>
				</ul>
			</Show>
			<Show when={workflow.modelError()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<Show when={workflow.sendError()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<Show when={workflow.attachmentError()}>
				{(error) => <span role="alert">{error()}</span>}
			</Show>
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
							workflow.attachments().some((item) => item.uploadState !== "complete") ||
							(!workflow.composerText().trim() && !workflow.attachments().length)
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
