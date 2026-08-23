import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Dialog } from "@kobalte/core/dialog";
import { FileField } from "@kobalte/core/file-field";
import { Tabs } from "@kobalte/core/tabs";
import { For, Show } from "solid-js";
import {
	type CharacterDisplay,
	type CharacterSummary,
	useCompanionStore,
} from "../stores/companion.js";
import { createBackstageWorkflowStore } from "../stores/backstage-workflows.js";
import { CanonStudio } from "./CanonStudio.js";
import { CharacterPackageWorkshop } from "./CharacterPackageWorkshop.js";
import { MemoryEntryList, MemorySheet } from "./MemorySheet.js";
import { SettingsSheet } from "./SettingsSheet.js";

/**
 * 幕后 — the backstage right-side sheet.
 *
 * Kobalte 0.13 ships no `Sheet` primitive, so the drawer is built on the
 * `Dialog` family (focus trap, ESC-to-close, aria-modal, labelled title),
 * styled as the prototype's right-side panel. Its role, memory, system,
 * and package-authoring areas live in `Tabs`; page state is internal.
 */
export function Backstage(props: {
	open: boolean;
	onClose: () => void;
	initialTab?: "roles" | "settings";
}) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = createBackstageWorkflowStore(useCompanionStore());
	workflow.syncInitialTab(props.initialTab);
	return (
		<Dialog open={props.open} onOpenChange={(isOpen) => { if (!isOpen) props.onClose(); }}>
			<Dialog.Portal>
				<Dialog.Overlay class="backstage-overlay" />
				<Dialog.Content class={props.initialTab === "settings" ? "backstage-sheet backstage-sheet-settings" : "backstage-sheet"}>
					<div class="backstage-head">
						<Dialog.Title class="backstage-title">
							{props.initialTab === "settings" ? t("sidebar.systemSettings") : t("sidebar.characterSettings")}
						</Dialog.Title>
						<Dialog.CloseButton class="backstage-close" aria-label={t("backstage.close")}>{t("backstage.close")}</Dialog.CloseButton>
					</div>
					<Show when={props.initialTab !== "settings"} fallback={<div class="standalone-settings-panel"><SettingsSheet /></div>}>
						<Tabs value={workflow.selectedTab()} onChange={workflow.setSelectedTab} class="backstage-tabs" aria-label={t("backstage.tabsLabel")}>
							<Tabs.List class="tabs">
								<Tabs.Trigger value="relationship" class="tab">{t("backstage.relationshipArchive")}</Tabs.Trigger>
								<Tabs.Trigger value="roles" class="tab">{t("backstage.roleManagement")}</Tabs.Trigger>
								<Tabs.Trigger value="memory" class="tab">{t("backstage.memory")}</Tabs.Trigger>
								<Tabs.Trigger value="studio" class="tab">{t("backstage.packageWorkshop")}</Tabs.Trigger>
							</Tabs.List>
							<Tabs.Content value="relationship" class="tab-panel"><Show when={workflow.selectedTab() === "relationship"}><RelationshipArchive /></Show></Tabs.Content>
							<Tabs.Content value="roles" class="tab-panel"><Show when={workflow.selectedTab() === "roles"}><RoleManager /></Show></Tabs.Content>
							<Tabs.Content value="memory" class="tab-panel"><Show when={workflow.selectedTab() === "memory"}><MemorySheet /></Show></Tabs.Content>
							<Tabs.Content value="studio" class="tab-panel"><Show when={workflow.selectedTab() === "studio"}>
								<CharacterPackageWorkshop />
								{/* <CanonStudio /> */}
							</Show></Tabs.Content>
						</Tabs>
					</Show>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}

function RoleManager() {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = createBackstageWorkflowStore(useCompanionStore());
	return (
		<div class="sheet-panel role-list">
			<div class="role-import">
				<p class="drawer-note">{t("backstage.roleImportHint")}</p>
				<FileField multiple disabled={workflow.importing()} onFileAccept={(files) => workflow.importPackage(files, t("backstage.roleImportDone"), t("backstage.roleImportFailed"))}>
					<FileField.Trigger class="button-like" aria-label={t("backstage.roleImport")}>{workflow.importing() ? t("backstage.roleImportBusy") : t("backstage.roleImport")}</FileField.Trigger>
					<FileField.HiddenInput aria-label={t("backstage.roleImport")} ref={(element) => element.setAttribute("webkitdirectory", "")} />
				</FileField>
				<Show when={workflow.roleFeedback()}><p role="status" class="status-line">{workflow.roleFeedback()}</p></Show>
			</div>
			<For each={workflow.characters()}>{(character) => <RoleRow character={character} />}</For>
		</div>
	);
}

function RoleRow(props: { character: CharacterSummary }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = createBackstageWorkflowStore(useCompanionStore());
	const trust = workflow.pluginTrust(props.character.id);
	const confirming = workflow.confirmingPlugins(props.character.id);
	const disabled = () => workflow.roleBusyId() !== undefined;
	const blocked = () => trust()?.pluginsPresent && !trust()?.trusted;
	return (
		<div class="role-row">
			<img src={props.character.avatarUrl} alt="" aria-hidden="true" />
			<div><strong>{props.character.name}</strong><span>{props.character.subtitle}</span><Show when={blocked()}><span class="role-plugin-warning">{t("backstage.rolePluginsDisabled")}</span></Show></div>
			<Show when={blocked()}><Button data-control="command" type="button" disabled={disabled()} onClick={() => workflow.setConfirmingPlugins(props.character.id, true)}>{t("backstage.roleEnablePlugins")}</Button></Show>
			<Show when={!props.character.active} fallback={<span class="role-active">{t("backstage.roleActive")}</span>}>
				<Button data-control="command" type="button" disabled={disabled()} onClick={() => workflow.activateRole(props.character.id)}>{t("backstage.roleSwitch")}</Button>
			</Show>
			<Dialog open={confirming()} onOpenChange={(value) => workflow.setConfirmingPlugins(props.character.id, value)}>
				<Dialog.Portal><Dialog.Overlay class="plugin-trust-overlay" /><Dialog.Content class="plugin-trust-dialog">
					<Dialog.Title>{t("backstage.rolePluginTrustTitle")}</Dialog.Title>
					<Dialog.Description>{t("backstage.rolePluginTrustDescription", { name: props.character.name })}</Dialog.Description>
					<dl class="plugin-trust-details"><dt>{t("backstage.rolePluginOrigin")}</dt><dd>{trust()?.origin}</dd><dt>{t("backstage.rolePluginHash")}</dt><dd><code>{trust()?.pluginHash}</code></dd></dl>
					<div class="plugin-trust-actions">
						<Dialog.CloseButton as={Button} data-control="command" type="button">{t("backstage.rolePluginCancel")}</Dialog.CloseButton>
						<Button data-control="command" type="button" disabled={disabled()} onClick={() => workflow.enablePlugins(props.character.id)}>{t("backstage.rolePluginTrustConfirm")}</Button>
					</div>
				</Dialog.Content></Dialog.Portal>
			</Dialog>
		</div>
	);
}


/** 关系档案: locked self-canon plus the relationship-scoped memories. */
function RelationshipArchive() {
	const [t] = useTranslation(undefined, { i18n });
	const companion = useCompanionStore();
	const workflow = createBackstageWorkflowStore(companion);
	return (
		<div class="sheet-panel">
			<Show when={companion.character}>{(character) => <div class="detail-card"><strong>{character().name}{t("backstage.identitySuffix")}</strong><span>{character().character.subtitle} · {character().character.scene_title}</span></div>}</Show>
			<p class="drawer-note">{t("backstage.identityNote")}</p>
			<div class="field"><div class="switch-field"><div class="switch-text"><span class="field-label">{t("settings.relationshipMemory")}</span><p class="field-hint">{t("settings.relationshipMemoryHint")}</p></div>
				<Button type="button" class="switch-control" role="switch" aria-label={t("settings.relationshipMemory")} aria-checked={workflow.relationshipEnabled()} data-checked={workflow.relationshipEnabled() || undefined} disabled={workflow.relationshipSaving() || !workflow.settingsAvailable()} onClick={() => workflow.toggleRelationshipMemory(t("settings.relationshipMemoryEnabled"), t("settings.relationshipMemoryDisabled"), t("errors.generic"))}><span class="switch-thumb" /></Button>
			</div></div>
			<div class="field"><div class="switch-field"><div class="switch-text"><span class="field-label">{t("settings.conversationHistoryRead")}</span><p class="field-hint">{t("settings.conversationHistoryReadHint")}</p></div>
				<Button type="button" class="switch-control" role="switch" aria-label={t("settings.conversationHistoryRead")} aria-checked={workflow.historyReadEnabled()} data-checked={workflow.historyReadEnabled() || undefined} disabled={workflow.relationshipSaving() || !workflow.settingsAvailable()} onClick={() => workflow.toggleHistoryRead(t("errors.generic"))}><span class="switch-thumb" /></Button>
			</div></div>
			<Show when={workflow.relationshipFeedback()}>{(message) => <p class="status-line">{message()}</p>}</Show>
			<Show when={workflow.relationshipError()}>{(message) => <p class="status-line err" role="alert">{message()}</p>}</Show>
			<MemoryEntryList scope="relationship" title={t("backstage.relationshipMemories")} />
			<RoleplayArchive />
		</div>
	);
}

function RoleplayArchive() {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = createBackstageWorkflowStore(useCompanionStore());
	const state = workflow.roleplay();
	return (
		<Tabs defaultValue="status" class="roleplay-archive">
			<Tabs.List aria-label={t("backstage.collections")} class="sub-tabs">
				<Tabs.Trigger value="status" class="tab">{t("backstage.roleplayStatus")}</Tabs.Trigger>
				<Tabs.Trigger value="collections" class="tab">{t("backstage.collections")}</Tabs.Trigger>
			</Tabs.List>
			<Tabs.Content value="status" class="tab-panel">
				<div class="roleplay-status-list">
					<For each={state.visibleVariables()}>{(variable) => <div class="roleplay-status-row"><span>{variable.display.kind === "hidden" ? variable.id : variable.display.label}</span><strong>{state.displayValue(variable)()}</strong></div>}</For>
				</div>
			</Tabs.Content>
			<Tabs.Content value="collections" class="tab-panel">
				<Show when={state.collections().length > 0} fallback={<p class="drawer-note">{t("backstage.collectionsEmpty")}</p>}>
					<div class="collection-grid">
						<For each={state.collections()}>{(entry) => <article class="collection-item"><Show when={state.mediaFor(entry.media)()}>{(item) => <RoleplayMedia media={item()} />}</Show><span class="collection-kind">{t(`backstage.collectionKinds.${entry.kind}`)}</span><strong>{entry.label}</strong><p>{entry.description}</p></article>}</For>
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
	if (media.kind !== "animation" || !media.posterUrl) return media.url;
	const prefersReducedMotion =
		typeof globalThis.matchMedia === "function" &&
		globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
	return prefersReducedMotion ? media.posterUrl : media.url;
}
