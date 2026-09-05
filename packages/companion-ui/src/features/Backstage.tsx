import { i18n, useTranslation } from "@bear-harness/i18n";
import { For, Show } from "solid-js";
import { createBackstageWorkflowStore } from "../stores/backstage-workflows.js";
import { type CharacterSummary, useCompanionStore } from "../stores/companion.js";
import { Button, Dialog, FileField } from "../ui/primitives.js";
import { CurrentRolePackageManager } from "./CurrentRolePackageManager.js";
import type { SettingsPage } from "./SettingsSheet.js";
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
	initialSettingsPage?: SettingsPage;
	onSettingsPageChange?: (page: SettingsPage) => void;
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
								<SettingsSheet
									initialPage={props.initialSettingsPage}
									onPageChange={props.onSettingsPageChange}
								/>
							</div>
						}
					>
						<RoleManager />
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
	const deletionQuery = companion.characters.observeDeletionStatus?.(
		workflow.selectedPackageId,
	) ?? {
		data: () => undefined,
		loading: () => false,
		error: () => undefined,
	};
	return (
		<div class="sheet-panel role-list role-settings-scroll">
			<aside class="role-library">
				<div class="role-import">
					<p class="drawer-note">{t("backstage.roleImportHint")}</p>
					<FileField
						multiple
						maxFiles={Number.POSITIVE_INFINITY}
						disabled={workflow.importing()}
						onFileAccept={(files) =>
							workflow.importPackage(
								files,
								t("backstage.roleImportDone"),
								t("backstage.roleImportFailed"),
							)
						}
						onFileReject={() => workflow.rejectPackageImport(t("backstage.roleImportFailed"))}
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
				<div class="role-library-list">
					<For each={workflow.characters()}>{(character) => <RoleRow character={character} />}</For>
				</div>
			</aside>
			<CurrentRolePackageManager
				characters={workflow.characters}
				selectedId={workflow.selectedPackageId}
				document={workflow.selectedPackage}
				loading={workflow.selectedPackageLoading}
				error={workflow.selectedPackageError}
				selectPackage={workflow.selectPackage}
				savePackage={workflow.savePackage}
				revealPackage={(id) => companion.characters.packageReveal(id)}
				pluginTrust={(id) => companion.characters.pluginTrust(id)}
				confirmPluginTrust={async (id) => {
					await companion.characters.confirmPluginTrust(id);
					await companion.characters.list();
				}}
				pluginTrustData={(id) => companion.characters.pluginTrustData(id)}
				deletionStatus={() => deletionQuery.data()?.status}
				deletionStatusLoading={deletionQuery.loading}
				deletionStatusError={() => {
					const error = deletionQuery.error();
					return error instanceof Error ? error.message : error ? String(error) : undefined;
				}}
				deleteRuntime={(id) => companion.characters.runtimeDelete(id)}
				deletePackage={async (id) => {
					const result = await companion.characters.packageDelete(id);
					workflow.packageDeleted(id);
					return result;
				}}
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
	let pluginTrustOpener: HTMLElement | undefined;
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
			<Dialog
				open={confirming()}
				onOpenChange={(value) => workflow.setConfirmingPlugins(props.character.id, value)}
			>
				<Show when={blocked()}>
					<Dialog.Trigger
						as={Button}
						ref={(element) => {
							pluginTrustOpener = element;
						}}
						data-control="command"
						type="button"
						disabled={disabled()}
					>
						{t("backstage.roleEnablePlugins")}
					</Dialog.Trigger>
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
				<Dialog.Portal>
					<Dialog.Overlay class="plugin-trust-overlay" />
					<Dialog.Content
						class="plugin-trust-dialog"
						onCloseAutoFocus={(event) => {
							event.preventDefault();
							if (pluginTrustOpener?.isConnected) pluginTrustOpener.focus();
						}}
					>
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
