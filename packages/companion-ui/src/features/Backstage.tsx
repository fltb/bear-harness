import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Dialog } from "@kobalte/core/dialog";
import { FileField } from "@kobalte/core/file-field";
import { Tabs } from "@kobalte/core/tabs";
import { For, Show } from "solid-js";
import { createBackstageWorkflowStore } from "../stores/backstage-workflows.js";
import { type CharacterSummary, useCompanionStore } from "../stores/companion.js";
import { CanonStudio } from "./CanonStudio.js";
import { CurrentRolePackageManager } from "./CurrentRolePackageManager.js";
import { MemorySheet } from "./MemorySheet.js";
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
	returnFocus?: () => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = createBackstageWorkflowStore(useCompanionStore());
	workflow.syncInitialTab(props.initialTab);
	return (
		<Dialog
			open={props.open}
			onOpenChange={(isOpen) => {
				if (!isOpen) props.onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay class="backstage-overlay" />
				<Dialog.Content
					onEscapeKeyDown={(event) => {
						const target = event.target;
						if (target instanceof Element && target.closest('[role="listbox"]')) {
							event.preventDefault();
						}
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						props.returnFocus?.();
					}}
					class={
						props.initialTab === "settings"
							? "backstage-sheet backstage-sheet-settings settings-dialog"
							: "backstage-sheet"
					}
				>
					<div class="backstage-head">
						<Dialog.Title class="backstage-title">
							{props.initialTab === "settings"
								? t("sidebar.systemSettings")
								: t("sidebar.characterSettings")}
						</Dialog.Title>
						<Dialog.CloseButton class="backstage-close" aria-label={t("backstage.close")}>
							{t("backstage.close")}
						</Dialog.CloseButton>
					</div>
					<Show
						when={props.initialTab !== "settings"}
						fallback={
							<div class="standalone-settings-panel">
								<SettingsSheet />
							</div>
						}
					>
						<Tabs
							value={workflow.selectedTab()}
							onChange={workflow.setSelectedTab}
							class="backstage-tabs"
							aria-label={t("backstage.tabsLabel")}
						>
							<Tabs.List class="tabs">
								<Tabs.Trigger value="roles" class="tab">
									{t("backstage.roleManagement")}
								</Tabs.Trigger>
								<Tabs.Trigger value="memory" class="tab">
									{t("backstage.memory")}
								</Tabs.Trigger>
								<Tabs.Trigger value="canon" class="tab">
									{t("backstage.canon")}
								</Tabs.Trigger>
							</Tabs.List>
							<Tabs.Content value="roles" class="tab-panel">
								<Show when={workflow.selectedTab() === "roles"}>
									<RoleManager />
								</Show>
							</Tabs.Content>
							<Tabs.Content value="memory" class="tab-panel">
								<Show when={workflow.selectedTab() === "memory"}>
									<MemorySheet />
								</Show>
							</Tabs.Content>
							<Tabs.Content value="canon" class="tab-panel">
								<Show when={workflow.selectedTab() === "canon"}>
									<CanonStudio />
								</Show>
							</Tabs.Content>
						</Tabs>
					</Show>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}

function RoleManager() {
	const [t] = useTranslation(undefined, { i18n });
	const companion = useCompanionStore();
	const workflow = createBackstageWorkflowStore(companion);
	return (
		<div class="sheet-panel role-list">
			<div class="role-import">
				<p class="drawer-note">{t("backstage.roleImportHint")}</p>
				<FileField
					multiple
					disabled={workflow.importing()}
					onFileAccept={(files) =>
						workflow.importPackage(
							files,
							t("backstage.roleImportDone"),
							t("backstage.roleImportFailed"),
						)
					}
				>
					<FileField.Trigger class="button-like" aria-label={t("backstage.roleImport")}>
						{workflow.importing() ? t("backstage.roleImportBusy") : t("backstage.roleImport")}
					</FileField.Trigger>
					<FileField.HiddenInput
						aria-label={t("backstage.roleImportInput")}
						ref={(element) => element.setAttribute("webkitdirectory", "")}
					/>
				</FileField>
				<Show when={workflow.roleFeedback()}>
					<p role="status" class="status-line">
						{workflow.roleFeedback()}
					</p>
				</Show>
			</div>
			<For each={workflow.characters()}>{(character) => <RoleRow character={character} />}</For>
			<CurrentRolePackageManager
				characters={workflow.characters}
				selectedId={workflow.selectedPackageId}
				document={workflow.selectedPackage}
				loading={workflow.selectedPackageLoading}
				error={workflow.selectedPackageError}
				selectPackage={workflow.selectPackage}
				savePackage={workflow.savePackage}
				pluginTrust={(id) => companion.characters.pluginTrust(id)}
				confirmPluginTrust={async (id) => {
					await companion.characters.confirmPluginTrust(id);
					await companion.characters.list();
				}}
				pluginTrustData={(id) => companion.characters.pluginTrustData(id)}
				settingsData={(id) => companion.settings.data(id)}
				memoryCandidates={(id) => companion.memory.candidateState("pending", id).candidates}
				settingsGet={(id) => companion.settings.get(id)}
				settingsUpdate={(id, settings) => companion.settings.set(settings, id)}
				listMemoryCandidates={(id) => companion.memory.listCandidates("pending", id)}
				approveMemoryCandidate={(id, candidateId) =>
					companion.memory.approveCandidate(candidateId, undefined, "relationship", id)
				}
				rejectMemoryCandidate={(id, candidateId) =>
					companion.memory.rejectCandidate(candidateId, id)
				}
			/>
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
			<div>
				<strong>{props.character.name}</strong>
				<span>{props.character.subtitle}</span>
				<Show when={blocked()}>
					<span class="role-plugin-warning">{t("backstage.rolePluginsDisabled")}</span>
				</Show>
			</div>
			<Show when={blocked()}>
				<Button
					data-control="command"
					type="button"
					disabled={disabled()}
					onClick={() => workflow.setConfirmingPlugins(props.character.id, true)}
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
					disabled={disabled()}
					onClick={() => workflow.activateRole(props.character.id)}
				>
					{t("backstage.roleSwitch")}
				</Button>
			</Show>
			<Dialog
				open={confirming()}
				onOpenChange={(value) => workflow.setConfirmingPlugins(props.character.id, value)}
			>
				<Dialog.Portal>
					<Dialog.Overlay class="plugin-trust-overlay" />
					<Dialog.Content class="plugin-trust-dialog">
						<Dialog.Title>{t("backstage.rolePluginTrustTitle")}</Dialog.Title>
						<Dialog.Description>
							{t("backstage.rolePluginTrustDescription", { name: props.character.name })}
						</Dialog.Description>
						<dl class="plugin-trust-details">
							<dt>{t("backstage.rolePluginOrigin")}</dt>
							<dd>{trust()?.origin}</dd>
							<dt>{t("backstage.rolePluginHash")}</dt>
							<dd>
								<code>{trust()?.pluginHash}</code>
							</dd>
						</dl>
						<div class="plugin-trust-actions">
							<Dialog.CloseButton
								as={Button}
								data-control="command"
								type="button"
								aria-label={t("backstage.rolePluginCancel")}
							>
								{t("backstage.rolePluginCancel")}
							</Dialog.CloseButton>
							<Button
								data-control="command"
								type="button"
								disabled={disabled()}
								onClick={() => workflow.enablePlugins(props.character.id)}
							>
								{t("backstage.rolePluginTrustConfirm")}
							</Button>
						</div>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
		</div>
	);
}
