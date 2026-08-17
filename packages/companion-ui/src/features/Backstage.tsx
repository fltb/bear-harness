import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { FileField } from "@kobalte/core/file-field";
import { Tabs } from "@kobalte/core/tabs";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createResource, createSignal, For, onMount, Show } from "solid-js";
import {
	type CharacterDisplay,
	type CharacterSummary,
	useCompanionStore,
} from "../stores/companion.js";
import { CanonStudio } from "./CanonStudio.js";
import { CharacterPackageWorkshop } from "./CharacterPackageWorkshop.js";
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
	const [t] = useTranslation(undefined, { i18n });
	const [selectedTab, setSelectedTab] = createSignal(props.initialTab ?? "roles");
	createEffect(() => setSelectedTab(props.initialTab ?? "roles"));
	return (
		<Dialog
			open={props.open}
			onOpenChange={(isOpen) => {
				if (!isOpen) props.onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay class="backstage-overlay" />
				<Dialog.Content class="backstage-sheet">
					<div class="backstage-head">
						<Dialog.Title class="backstage-title">{t("backstage.title")}</Dialog.Title>
						<Dialog.CloseButton class="backstage-close" aria-label={t("backstage.close")}>
							{t("backstage.close")}
						</Dialog.CloseButton>
					</div>
					<Tabs
						value={selectedTab()}
						onChange={setSelectedTab}
						class="backstage-tabs"
						aria-label={t("backstage.tabsLabel")}
					>
						<Tabs.List class="tabs">
							<Tabs.Trigger value="relationship" class="tab">
								{t("backstage.relationshipArchive")}
							</Tabs.Trigger>
							<Tabs.Trigger value="roles" class="tab">
								{t("backstage.roleManagement")}
							</Tabs.Trigger>
							<Tabs.Trigger value="memory" class="tab">
								{t("backstage.memory")}
							</Tabs.Trigger>
							<Tabs.Trigger value="story" class="tab">
								{t("backstage.storyArchive")}
							</Tabs.Trigger>
							<Tabs.Trigger value="settings" class="tab">
								{t("backstage.systemSettings")}
							</Tabs.Trigger>
							<Tabs.Trigger value="studio" class="tab">
								{t("backstage.packageWorkshop")}
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
							<CharacterPackageWorkshop />
							<CanonStudio />
						</Tabs.Content>
					</Tabs>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}

function RoleManager() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [busyId, setBusyId] = createSignal<string>();
	const [importing, setImporting] = createSignal(false);
	const [feedback, setFeedback] = createSignal<string>();
	const importPackage = async (files: File[]) => {
		if (files.length === 0) return;
		setImporting(true);
		setFeedback();
		try {
			const payload = await Promise.all(
				files.map(async (file) => {
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
			setFeedback(t("backstage.roleImportDone"));
		} catch (error) {
			setFeedback(
				`${t("backstage.roleImportFailed")}${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			setImporting(false);
		}
	};
	return (
		<div class="sheet-panel role-list">
			<div class="role-import">
				<p class="drawer-note">{t("backstage.roleImportHint")}</p>
				<FileField
					multiple
					disabled={importing()}
					onFileAccept={(files) => void importPackage(files)}
				>
					<FileField.Trigger class="button-like" aria-label={t("backstage.roleImport")}>
						{importing() ? t("backstage.roleImportBusy") : t("backstage.roleImport")}
					</FileField.Trigger>
					<FileField.HiddenInput
						aria-label={t("backstage.roleImport")}
						ref={(element) => element.setAttribute("webkitdirectory", "")}
					/>
				</FileField>
				<Show when={feedback()}>
					<p role="status" class="status-line">
						{feedback()}
					</p>
				</Show>
			</div>
			<For each={store.characters.characters()}>
				{(character) => <RoleRow character={character} busyId={busyId()} setBusyId={setBusyId} />}
			</For>
		</div>
	);
}

function RoleRow(props: {
	character: CharacterSummary;
	busyId: string | undefined;
	setBusyId: (value: string | undefined) => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [trust, { refetch }] = createResource(
		() => props.character.id,
		(characterId) => store.characters.pluginTrust(characterId),
	);
	return (
		<div class="role-row">
			<img src={props.character.avatarUrl} alt="" aria-hidden="true" />
			<div>
				<strong>{props.character.name}</strong>
				<span>{props.character.subtitle}</span>
				<Show when={trust()?.pluginsPresent && !trust()?.trusted}>
					<span class="role-plugin-warning">{t("backstage.rolePluginsDisabled")}</span>
				</Show>
			</div>
			<Show when={trust()?.pluginsPresent && !trust()?.trusted}>
				<Button
					data-control="command"
					type="button"
					disabled={props.busyId !== undefined}
					onClick={() => {
						props.setBusyId(props.character.id);
						void store.characters
							.confirmPluginTrust(props.character.id)
							.then(() => refetch())
							.finally(() => props.setBusyId(undefined));
					}}
				>
					{t("backstage.roleEnablePlugins")}
				</Button>
			</Show>
			<Show
				when={!props.character.active}
				fallback={<span class="role-active">{t("backstage.roleActive")}</span>}
			>
				<Button
					data-control="command"
					type="button"
					disabled={props.busyId !== undefined}
					onClick={() => {
						props.setBusyId(props.character.id);
						void store.characters
							.activate(props.character.id)
							.finally(() => props.setBusyId(undefined));
					}}
				>
					{t("backstage.roleSwitch")}
				</Button>
			</Show>
		</div>
	);
}

function StoryArchive() {
	const [t] = useTranslation(undefined, { i18n });
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
			<p class="drawer-note">{t("backstage.storyOriginal")}</p>
			<Show
				when={store.story.changes().length > 0}
				fallback={<p class="drawer-note">{t("backstage.storyEmpty")}</p>}
			>
				<div class="story-change-list">
					<For each={store.story.changes()}>
						{(change) => (
							<div class="story-change">
								<span>{change.text}</span>
								<Button
									data-control="command"
									type="button"
									disabled={busy()}
									onClick={() => void store.story.revert(change.id)}
								>
									{t("backstage.storyUndo")}
								</Button>
							</div>
						)}
					</For>
				</div>
			</Show>
			<form class="story-add" onSubmit={add}>
				<TextField>
					<TextField.TextArea
						rows={3}
						aria-label={t("backstage.storyAddPlaceholder")}
						placeholder={t("backstage.storyAddPlaceholder")}
						value={text()}
						onInput={(event) => setText(event.currentTarget.value)}
					/>
				</TextField>
				<Checkbox checked={branchOnly()} onChange={setBranchOnly}>
					<Checkbox.Input />
					<Checkbox.Control>
						<Checkbox.Indicator>✓</Checkbox.Indicator>
					</Checkbox.Control>
					<Checkbox.Label>{t("backstage.storyBranchOnly")}</Checkbox.Label>
				</Checkbox>
				<Button data-control="command" type="submit" disabled={busy() || !text().trim()}>
					{t("backstage.storyAdd")}
				</Button>
			</form>
			<Button
				type="button"
				class="story-reset"
				disabled={busy()}
				onClick={() => void store.story.reset()}
			>
				{t("backstage.storyReset")}
			</Button>
		</div>
	);
}

/** 关系档案: locked self-canon plus the relationship-scoped memories. */
function RelationshipArchive(props: { character: CharacterDisplay | undefined }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [saving, setSaving] = createSignal(false);
	const [feedback, setFeedback] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	onMount(() => void store.settings.get());
	const enabled = () => store.settings.data()?.relationshipMemoryEnabled ?? false;
	const historyReadEnabled = () => store.settings.data()?.conversationHistoryReadEnabled ?? false;
	const toggleMemory = async (): Promise<void> => {
		setSaving(true);
		setFeedback();
		setError();
		const next = !enabled();
		try {
			await store.settings.set({ relationshipMemoryEnabled: next });
			setFeedback(
				next ? t("settings.relationshipMemoryEnabled") : t("settings.relationshipMemoryDisabled"),
			);
		} catch {
			setError(t("errors.generic"));
		} finally {
			setSaving(false);
		}
	};
	const toggleHistoryRead = async (): Promise<void> => {
		setSaving(true);
		setFeedback();
		setError();
		try {
			await store.settings.set({ conversationHistoryReadEnabled: !historyReadEnabled() });
		} catch {
			setError(t("errors.generic"));
		} finally {
			setSaving(false);
		}
	};
	return (
		<div class="sheet-panel">
			<Show when={props.character}>
				{(character) => (
					<div class="detail-card">
						<strong>
							{character().name}
							{t("backstage.identitySuffix")}
						</strong>
						<span>
							{character().character.subtitle} · {character().character.scene_title}
						</span>
					</div>
				)}
			</Show>
			<p class="drawer-note">{t("backstage.identityNote")}</p>
			<div class="field">
				<div class="switch-field">
					<div class="switch-text">
						<span class="field-label">{t("settings.relationshipMemory")}</span>
						<p class="field-hint">{t("settings.relationshipMemoryHint")}</p>
					</div>
					<Button
						type="button"
						class="switch-control"
						role="switch"
						aria-label={t("settings.relationshipMemory")}
						aria-checked={enabled()}
						data-checked={enabled() || undefined}
						disabled={saving() || store.settings.data() === undefined}
						onClick={() => void toggleMemory()}
					>
						<span class="switch-thumb" />
					</Button>
				</div>
			</div>
			<div class="field">
				<div class="switch-field">
					<div class="switch-text">
						<span class="field-label">{t("settings.conversationHistoryRead")}</span>
						<p class="field-hint">{t("settings.conversationHistoryReadHint")}</p>
					</div>
					<Button
						type="button"
						class="switch-control"
						role="switch"
						aria-label={t("settings.conversationHistoryRead")}
						aria-checked={historyReadEnabled()}
						data-checked={historyReadEnabled() || undefined}
						disabled={saving() || store.settings.data() === undefined}
						onClick={() => void toggleHistoryRead()}
					>
						<span class="switch-thumb" />
					</Button>
				</div>
			</div>
			<Show when={feedback()}>{(message) => <p class="status-line">{message()}</p>}</Show>
			<Show when={error()}>
				{(message) => (
					<p class="status-line err" role="alert">
						{message()}
					</p>
				)}
			</Show>
			<MemoryEntryList scope="relationship" title={t("backstage.relationshipMemories")} />
			<RoleplayArchive character={props.character} />
		</div>
	);
}

function RoleplayArchive(props: { character: CharacterDisplay | undefined }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const visibleVariables = () =>
		props.character?.roleplay.variables.filter((variable) => variable.display.kind !== "hidden") ??
		[];
	const unlocked = () => new Set(store.roleplay?.unlocked ?? []);
	const collections = () =>
		props.character?.roleplay.unlockables.filter((entry) => unlocked().has(entry.id)) ?? [];
	const media = (id: string | undefined) =>
		props.character?.roleplay.media.find((entry) => entry.id === id);
	const displayValue = (variable: CharacterDisplay["roleplay"]["variables"][number]): string => {
		const value = store.roleplay?.values[variable.id] ?? variable.initial;
		if (variable.display.kind !== "level" || typeof value !== "number") return String(value);
		return (
			[...variable.display.levels]
				.sort((left, right) => right.min - left.min)
				.find((level) => value >= level.min)?.label ?? String(value)
		);
	};
	return (
		<Tabs defaultValue="status" class="roleplay-archive">
			<Tabs.List aria-label={t("backstage.collections")} class="sub-tabs">
				<Tabs.Trigger value="status" class="tab">
					{t("backstage.roleplayStatus")}
				</Tabs.Trigger>
				<Tabs.Trigger value="collections" class="tab">
					{t("backstage.collections")}
				</Tabs.Trigger>
			</Tabs.List>
			<Tabs.Content value="status" class="tab-panel">
				<div class="roleplay-status-list">
					<For each={visibleVariables()}>
						{(variable) => (
							<div class="roleplay-status-row">
								<span>
									{variable.display.kind === "hidden" ? variable.id : variable.display.label}
								</span>
								<strong>{displayValue(variable)}</strong>
							</div>
						)}
					</For>
				</div>
			</Tabs.Content>
			<Tabs.Content value="collections" class="tab-panel">
				<Show
					when={collections().length > 0}
					fallback={<p class="drawer-note">{t("backstage.collectionsEmpty")}</p>}
				>
					<div class="collection-grid">
						<For each={collections()}>
							{(entry) => {
								const asset = () => media(entry.media);
								return (
									<article class="collection-item">
										<Show when={asset()}>{(item) => <RoleplayMedia media={item()} />}</Show>
										<span class="collection-kind">
											{t(`backstage.collectionKinds.${entry.kind}`)}
										</span>
										<strong>{entry.label}</strong>
										<p>{entry.description}</p>
									</article>
								);
							}}
						</For>
					</div>
				</Show>
			</Tabs.Content>
		</Tabs>
	);
}

function RoleplayMedia(props: { media: CharacterDisplay["roleplay"]["media"][number] }) {
	if (props.media.kind === "audio")
		return (
			<audio controls preload="metadata" src={props.media.url} aria-label={props.media.label}>
				<track kind="captions" src={props.media.captionsUrl} srclang="und" default />
			</audio>
		);
	if (props.media.kind === "video")
		return (
			<video
				controls
				preload="metadata"
				poster={props.media.posterUrl}
				src={props.media.url}
				aria-label={props.media.label}
			>
				<track kind="captions" src={props.media.captionsUrl} srclang="und" default />
			</video>
		);
	return <img loading="lazy" src={roleplayImageUrl(props.media)} alt={props.media.label} />;
}

function roleplayImageUrl(media: CharacterDisplay["roleplay"]["media"][number]): string {
	return media.kind === "animation" &&
		media.posterUrl &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
		? media.posterUrl
		: media.url;
}
