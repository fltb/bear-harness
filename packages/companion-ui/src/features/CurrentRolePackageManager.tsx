import { i18n, useTranslation } from "@bear-harness/i18n";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { CharacterDeletionStatus, CharacterPackageDocument } from "../stores/companion.js";
import { Button, Dialog } from "../ui/primitives.js";

type PluginTrust = {
	origin: CharacterPackageDocument["origin"];
	pluginHash: string;
	pluginsPresent: boolean;
	trusted: boolean;
};

function desktopBridgeAvailable(): boolean {
	const bridge = (
		globalThis as typeof globalThis & {
			bearDesktop?: { platform?: unknown; transport?: { invoke?: unknown } };
		}
	).bearDesktop;
	return typeof bridge?.platform === "string" && typeof bridge.transport?.invoke === "function";
}

export function CurrentRolePackageManager(props: {
	onEditPackage?: (id: string) => void;
	characters: () => Array<{ id: string; name: string; active: boolean }>;
	selectedId: () => string | undefined;
	memory?: JSX.Element;
	modelSettings?: JSX.Element;
	document: () => CharacterPackageDocument | undefined;
	loading: () => boolean;
	error: () => string | undefined;
	selectPackage: (id: string, confirmDiscard: () => boolean) => void;
	revealPackage: (id: string) => Promise<void>;
	pluginTrust: (id: string) => Promise<PluginTrust>;
	pluginTrustData: (id: string) => PluginTrust | undefined;
	confirmPluginTrust: (id: string) => Promise<void>;
	deletionStatus: () => CharacterDeletionStatus | undefined;
	deletionStatusLoading: () => boolean;
	deletionStatusError: () => string | undefined;
	deleteRuntime: (id: string) => Promise<{ deleted: boolean }>;
	deletePackage: (id: string) => Promise<{ deleted: boolean }>;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const documentId = () => props.document()?.characterId ?? "";
	const [saveError, setSaveError] = createSignal<string>();
	const [revealError, setRevealError] = createSignal<string>();
	const [saving, setSaving] = createSignal(false);
	const trust = () => props.pluginTrustData(documentId());
	const [pendingDeletion, setPendingDeletion] = createSignal<"runtime" | "package">();
	const [deleting, setDeleting] = createSignal(false);
	const [deletionFeedback, setDeletionFeedback] = createSignal<string>();
	const load = (id: string) => props.selectPackage(id, () => true);

	const enablePlugins = async () => {
		const characterId = documentId();
		if (!characterId) return;
		setSaving(true);
		try {
			await props.confirmPluginTrust(characterId);
			await props.pluginTrust(characterId);
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};
	const reveal = async () => {
		const characterId = documentId();
		if (!characterId) return;
		setRevealError(undefined);
		try {
			await props.revealPackage(characterId);
		} catch (error) {
			setRevealError(error instanceof Error ? error.message : String(error));
		}
	};
	const deletionErrorMessage = (error: unknown): string => {
		const reason =
			typeof error === "object" && error !== null && "reason" in error ? String(error.reason) : "";
		switch (reason) {
			case "character_package_default":
				return t("currentRolePackage.deleteBlockedDefault");
			case "character_runtime_exists":
				return t("currentRolePackage.deleteBlockedRuntimePresent");
			default:
				return error instanceof Error ? error.message : String(error);
		}
	};
	const confirmDeletion = async () => {
		const target = pendingDeletion();
		const current = props.document();
		if (!target || !current) return;
		setDeleting(true);
		setDeletionFeedback(undefined);
		try {
			const result =
				target === "runtime"
					? await props.deleteRuntime(current.characterId)
					: await props.deletePackage(current.characterId);
			setPendingDeletion(undefined);
			setDeletionFeedback(
				t(
					target === "runtime"
						? result.deleted
							? "currentRolePackage.runtimeDeleted"
							: "currentRolePackage.runtimeAlreadyAbsent"
						: result.deleted
							? "currentRolePackage.packageDeleted"
							: "currentRolePackage.packageAlreadyAbsent",
					{ name: current.character.name },
				),
			);
		} catch (error) {
			setDeletionFeedback(deletionErrorMessage(error));
		} finally {
			setDeleting(false);
		}
	};
	return (
		<section class="current-role-package-manager">
			<section
				class="current-role-package-selector"
				aria-label={t("currentRolePackage.selectorLabel")}
			>
				<For each={props.characters()}>
					{(character) => (
						<Button
							data-control="command"
							class="current-role-package-choice"
							data-selected={character.id === props.selectedId() || undefined}
							type="button"
							onClick={() => void load(character.id)}
						>
							{character.name}
							{character.active ? t("currentRolePackage.activeSuffix") : ""}
						</Button>
					)}
				</For>
			</section>
			{props.memory}
			{props.modelSettings}
			<Show when={props.loading()}>
				<p class="status-line" role="status">
					{t("currentRolePackage.loading")}
				</p>
			</Show>
			<Show when={props.error()}>
				{(message) => (
					<p class="status-line err" role="alert">
						{message()}
					</p>
				)}
			</Show>
			<Show when={props.document()}>
				{(current) => (
					<>
						<header class="current-role-package-summary">
							<div>
								<strong>{current().character.name}</strong>
								<span>{current().character.character.subtitle}</span>
							</div>
							<details class="role-package-metadata">
								<summary>{t("currentRolePackage.advancedDetails")}</summary>
								<dl>
									<dt>{t("currentRolePackage.source")}</dt>
									<dd>{current().origin}</dd>
									<dt>{t("currentRolePackage.writeAccess")}</dt>
									<dd>
										{current().writable
											? t("currentRolePackage.writable")
											: t("currentRolePackage.readOnly")}
									</dd>
									<dt>{t("currentRolePackage.revision")}</dt>
									<dd>
										<code>{current().sha256.slice(0, 12)}</code>
									</dd>
								</dl>
							</details>
							<Show when={desktopBridgeAvailable()}>
								<Button type="button" onClick={() => void reveal()}>
									{t("currentRolePackage.revealPackage")}
								</Button>
							</Show>
						</header>
						<Show when={revealError()}>
							{(message) => (
								<p class="status-line err" role="alert">
									{message()}
								</p>
							)}
						</Show>
						<Show when={trust()?.pluginsPresent}>
							<div class="detail-card">
								<strong>{t("currentRolePackage.pluginTrust")}</strong>
								<span>
									{`${trust()?.trusted ? t("currentRolePackage.pluginTrusted") : t("currentRolePackage.pluginDisabled")} · ${trust()?.pluginHash.slice(0, 12)}`}
								</span>
								<Show when={!trust()?.trusted}>
									<Button type="button" disabled={saving()} onClick={() => void enablePlugins()}>
										{t("currentRolePackage.enablePlugins")}
									</Button>
								</Show>
							</div>
						</Show>
						<Show when={props.onEditPackage}>
							<Button onClick={() => props.onEditPackage?.(documentId())}>
								{t("studio.editRole")}
							</Button>
						</Show>
						<Show when={saveError()}>
							<p role="alert">{saveError()}</p>
						</Show>
						<section
							class="character-deletion-zone"
							aria-label={t("currentRolePackage.localDataTitle")}
						>
							<header>
								<strong>{t("currentRolePackage.localDataTitle")}</strong>
								<span>{t("currentRolePackage.localDataDescription")}</span>
							</header>
							<Show when={props.deletionStatusLoading()}>
								<p class="status-line" role="status">
									{t("currentRolePackage.deletionStatusLoading")}
								</p>
							</Show>
							<div class="character-deletion-option">
								<div>
									<strong>{t("currentRolePackage.deleteRuntime")}</strong>
									<span>{t("currentRolePackage.deleteRuntimeDescription")}</span>
									<Show when={props.deletionStatus() && !props.deletionStatus()?.runtimePresent}>
										<small>{t("currentRolePackage.runtimeAlreadyAbsent")}</small>
									</Show>
								</div>
								<Button
									data-variant="danger"
									type="button"
									disabled={
										deleting() || !props.deletionStatus() || !props.deletionStatus()?.runtimePresent
									}
									onClick={() => setPendingDeletion("runtime")}
								>
									{t("currentRolePackage.deleteRuntime")}
								</Button>
							</div>
							<div class="character-deletion-option">
								<div>
									<strong>{t("currentRolePackage.deletePackage")}</strong>
									<span>{t("currentRolePackage.deletePackageDescription")}</span>
									<Show when={props.deletionStatus()?.default}>
										<small>{t("currentRolePackage.deleteBlockedDefault")}</small>
									</Show>
									<Show when={props.deletionStatus()?.runtimePresent}>
										<small>{t("currentRolePackage.deleteBlockedRuntimePresent")}</small>
									</Show>
								</div>
								<Button
									data-variant="danger"
									type="button"
									disabled={
										deleting() ||
										!props.deletionStatus() ||
										props.deletionStatus()?.default ||
										props.deletionStatus()?.runtimePresent ||
										!props.deletionStatus()?.packagePresent
									}
									onClick={() => setPendingDeletion("package")}
								>
									{t("currentRolePackage.deletePackage")}
								</Button>
							</div>
							<Show when={props.deletionStatusError()}>
								{(message) => (
									<p class="status-line err" role="alert">
										{message()}
									</p>
								)}
							</Show>
							<Show when={deletionFeedback()}>
								{(message) => (
									<p class="status-line" role="status">
										{message()}
									</p>
								)}
							</Show>
						</section>
						<Dialog
							open={pendingDeletion() !== undefined}
							onOpenChange={(open) => {
								if (!open && !deleting()) setPendingDeletion(undefined);
							}}
						>
							<Dialog.Portal>
								<Dialog.Overlay class="confirmation-overlay" />
								<Dialog.Content class="confirmation-dialog">
									<Dialog.Title>
										{t(
											pendingDeletion() === "runtime"
												? "currentRolePackage.deleteRuntimeConfirmTitle"
												: "currentRolePackage.deletePackageConfirmTitle",
										)}
									</Dialog.Title>
									<Dialog.Description>
										{t(
											pendingDeletion() === "runtime"
												? "currentRolePackage.deleteRuntimeConfirmDescription"
												: "currentRolePackage.deletePackageConfirmDescription",
											{ name: current().character.name },
										)}
									</Dialog.Description>
									<div class="confirmation-actions">
										<Dialog.CloseButton as={Button} type="button" disabled={deleting()}>
											{t("currentRolePackage.deleteCancel")}
										</Dialog.CloseButton>
										<Button
											class="danger-action"
											type="button"
											disabled={deleting()}
											onClick={() => void confirmDeletion()}
										>
											{deleting()
												? t("currentRolePackage.deleting")
												: t("currentRolePackage.deleteConfirmAction")}
										</Button>
									</div>
								</Dialog.Content>
							</Dialog.Portal>
						</Dialog>
					</>
				)}
			</Show>
		</section>
	);
}
