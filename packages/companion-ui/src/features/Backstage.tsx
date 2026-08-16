import { productUi } from "@bear-harness/product-config";
import { Dialog, Tabs } from "@kobalte/core";
import { createEffect, createSignal, For, Show } from "solid-js";
import { type CharacterDisplay, useCompanionStore } from "../stores/companion.js";
import { CanonStudio } from "./CanonStudio.js";
import { MemoryEntryList, MemorySheet } from "./MemorySheet.js";
import { SettingsSheet } from "./SettingsSheet.js";

/**
 * 幕后 — the backstage right-side sheet.
 *
 * Kobalte 0.13 ships no `Sheet` primitive, so the drawer is built on the
 * `Dialog` family (focus trap, ESC-to-close, aria-modal, labelled title),
 * styled as the prototype's right-side panel. Its role, memory, story, system,
 * and package-authoring areas live in `Tabs`; page state is internal.
 */
export function Backstage(props: {
	open: boolean;
	onClose: () => void;
	character: CharacterDisplay | undefined;
	initialTab?: "roles" | "settings";
}) {
	const [selectedTab, setSelectedTab] = createSignal(props.initialTab ?? "roles");
	createEffect(() => setSelectedTab(props.initialTab ?? "roles"));
	return (
		<Dialog.Root
			open={props.open}
			onOpenChange={(isOpen) => {
				if (!isOpen) props.onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay class="backstage-overlay" />
				<Dialog.Content class="backstage-sheet">
					<div class="backstage-head">
						<Dialog.Title class="backstage-title">{productUi.backstage.title}</Dialog.Title>
						<Dialog.CloseButton class="backstage-close" aria-label={productUi.backstage.close}>
							{productUi.backstage.close}
						</Dialog.CloseButton>
					</div>
					<Tabs.Root
						value={selectedTab()}
						onChange={setSelectedTab}
						class="backstage-tabs"
						aria-label={productUi.backstage.tabsLabel}
					>
						<Tabs.List class="tabs">
							<Tabs.Trigger value="relationship" class="tab">
								{productUi.backstage.relationshipArchive}
							</Tabs.Trigger>
							<Tabs.Trigger value="roles" class="tab">
								{productUi.backstage.roleManagement}
							</Tabs.Trigger>
							<Tabs.Trigger value="memory" class="tab">
								{productUi.backstage.memory}
							</Tabs.Trigger>
							<Tabs.Trigger value="story" class="tab">
								{productUi.backstage.storyArchive}
							</Tabs.Trigger>
							<Tabs.Trigger value="settings" class="tab">
								{productUi.backstage.systemSettings}
							</Tabs.Trigger>
							<Tabs.Trigger value="studio" class="tab">
								{productUi.backstage.packageWorkshop}
							</Tabs.Trigger>
						</Tabs.List>
						<Tabs.Content value="relationship" class="tab-panel">
							<RelationshipArchive character={props.character} />
						</Tabs.Content>
						<Tabs.Content value="roles" class="tab-panel">
							<RoleManager />
						</Tabs.Content>
						<Tabs.Content value="memory" class="tab-panel">
							<MemorySheet />
						</Tabs.Content>
						<Tabs.Content value="story" class="tab-panel">
							<StoryArchive />
						</Tabs.Content>
						<Tabs.Content value="settings" class="tab-panel">
							<SettingsSheet />
						</Tabs.Content>
						<Tabs.Content value="studio" class="tab-panel">
							<CanonStudio />
						</Tabs.Content>
					</Tabs.Root>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function RoleManager() {
	const store = useCompanionStore();
	const [busyId, setBusyId] = createSignal<string>();
	const [importing, setImporting] = createSignal(false);
	const [feedback, setFeedback] = createSignal<string>();
	const importPackage = async (files: FileList | null) => {
		if (!files?.length) return;
		setImporting(true);
		setFeedback();
		try {
			const payload = await Promise.all(
				[...files].map(async (file) => {
					const bytes = new Uint8Array(await file.arrayBuffer());
					let binary = "";
					for (let offset = 0; offset < bytes.length; offset += 32_768) {
						binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
					}
					return {
						path: file.webkitRelativePath || file.name,
						base64: btoa(binary),
					};
				}),
			);
			await store.characters.import(payload);
			setFeedback(productUi.backstage.roleImportDone);
		} catch (error) {
			setFeedback(
				`${productUi.backstage.roleImportFailed}${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			setImporting(false);
		}
	};
	return (
		<div class="sheet-panel role-list">
			<div class="role-import">
				<p class="drawer-note">{productUi.backstage.roleImportHint}</p>
				<label class="button-like">
					{importing() ? productUi.backstage.roleImportBusy : productUi.backstage.roleImport}
					<input
						type="file"
						multiple
						aria-label={productUi.backstage.roleImport}
						disabled={importing()}
						ref={(element) => element.setAttribute("webkitdirectory", "")}
						onChange={(event) => void importPackage(event.currentTarget.files)}
					/>
				</label>
				<Show when={feedback()}>
					<p role="status" class="status-line">
						{feedback()}
					</p>
				</Show>
			</div>
			<For each={store.characters.characters()}>
				{(character) => (
					<div class="role-row">
						<img src={character.avatarUrl} alt="" aria-hidden="true" />
						<div>
							<strong>{character.name}</strong>
							<span>{character.subtitle}</span>
						</div>
						<Show
							when={!character.active}
							fallback={<span class="role-active">{productUi.backstage.roleActive}</span>}
						>
							<button
								type="button"
								disabled={busyId() !== undefined}
								onClick={() => {
									setBusyId(character.id);
									void store.characters.activate(character.id).finally(() => setBusyId());
								}}
							>
								{productUi.backstage.roleSwitch}
							</button>
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}

function StoryArchive() {
	const store = useCompanionStore();
	const [text, setText] = createSignal("");
	const [branchOnly, setBranchOnly] = createSignal(false);
	const [busy, setBusy] = createSignal(false);

	const add = async (event: SubmitEvent) => {
		event.preventDefault();
		const value = text().trim();
		if (!value) return;
		setBusy(true);
		try {
			await store.story.apply(value, branchOnly() ? "branch" : "global");
			setText("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div class="sheet-panel story-archive">
			<p class="drawer-note">{productUi.backstage.storyOriginal}</p>
			<Show
				when={store.story.changes().length > 0}
				fallback={<p class="drawer-note">{productUi.backstage.storyEmpty}</p>}
			>
				<div class="story-change-list">
					<For each={store.story.changes()}>
						{(change) => (
							<div class="story-change">
								<span>{change.text}</span>
								<button
									type="button"
									disabled={busy()}
									onClick={() => void store.story.revert(change.id)}
								>
									{productUi.backstage.storyUndo}
								</button>
							</div>
						)}
					</For>
				</div>
			</Show>
			<form class="story-add" onSubmit={add}>
				<textarea
					rows={3}
					aria-label={productUi.backstage.storyAddPlaceholder}
					placeholder={productUi.backstage.storyAddPlaceholder}
					value={text()}
					onInput={(event) => setText(event.currentTarget.value)}
				/>
				<label>
					<input
						type="checkbox"
						checked={branchOnly()}
						onChange={(event) => setBranchOnly(event.currentTarget.checked)}
					/>
					{productUi.backstage.storyBranchOnly}
				</label>
				<button type="submit" disabled={busy() || !text().trim()}>
					{productUi.backstage.storyAdd}
				</button>
			</form>
			<button
				type="button"
				class="story-reset"
				disabled={busy()}
				onClick={() => void store.story.reset()}
			>
				{productUi.backstage.storyReset}
			</button>
		</div>
	);
}

/** 关系档案: locked self-canon plus the relationship-scoped memories. */
function RelationshipArchive(props: { character: CharacterDisplay | undefined }) {
	return (
		<div class="sheet-panel">
			<Show when={props.character}>
				{(character) => (
					<div class="detail-card">
						<strong>
							{character().name}
							{productUi.backstage.identitySuffix}
						</strong>
						<span>
							{character().character.subtitle} · {character().character.scene_title}
						</span>
					</div>
				)}
			</Show>
			<p class="drawer-note">{productUi.backstage.identityNote}</p>
			<MemoryEntryList scope="relationship" title={productUi.backstage.relationshipMemories} />
		</div>
	);
}
