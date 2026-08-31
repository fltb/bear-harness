import { i18n, useTranslation } from "@bear-harness/i18n";
import { createSignal, For, Show } from "solid-js";
import { parseDocument, stringify } from "yaml";
import type { CharacterDeletionStatus, CharacterPackageDocument } from "../stores/companion.js";
import { Button, Dialog, Tabs, TextField } from "../ui/primitives.js";

const PROMPT_FIELDS = [
	"description",
	"personality",
	"scenario",
	"system_prompt",
	"mes_example",
] as const;
type PromptField = (typeof PROMPT_FIELDS)[number];
type PromptDraft = Record<PromptField, string>;

function promptFrom(document: CharacterPackageDocument): PromptDraft {
	return { ...document.character.prompt };
}

export function CurrentRolePackageManager(props: {
	characters: () => Array<{ id: string; name: string; active: boolean }>;
	selectedId: () => string | undefined;
	document: () => CharacterPackageDocument | undefined;
	loading: () => boolean;
	error: () => string | undefined;
	selectPackage: (id: string, confirmDiscard: () => boolean) => void;
	savePackage: (yaml: string, expectedSha256: string) => Promise<CharacterPackageDocument>;
	pluginTrust: (
		id: string,
	) => Promise<{ origin: string; pluginHash: string; pluginsPresent: boolean; trusted: boolean }>;
	pluginTrustData: (
		id: string,
	) =>
		| { origin: string; pluginHash: string; pluginsPresent: boolean; trusted: boolean }
		| undefined;
	settingsData: (id: string) => { relationshipMemoryEnabled: boolean } | undefined;
	confirmPluginTrust: (id: string) => Promise<void>;
	settingsUpdate: (id: string, settings: { relationshipMemoryEnabled?: boolean }) => Promise<void>;
	deletionStatus: () => CharacterDeletionStatus | undefined;
	deletionStatusLoading: () => boolean;
	deletionStatusError: () => string | undefined;
	deleteRuntime: (id: string) => Promise<{ deleted: boolean }>;
	deletePackage: (id: string) => Promise<{ deleted: boolean }>;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const selectedId = () => props.document()?.characterId ?? "";
	const [drafts, setDrafts] = createSignal<
		Record<string, { raw?: string; prompt?: PromptDraft; storage?: string; baseSha256?: string }>
	>({});
	const draft = () => drafts()[selectedId()];
	const raw = () => draft()?.raw ?? props.document()?.yaml ?? "";
	const savedRaw = () => props.document()?.yaml ?? "";
	const prompt = () =>
		draft()?.prompt ?? (props.document() ? promptFrom(props.document()!) : undefined);
	const storage = () =>
		draft()?.storage ?? stringify(parseDocument(savedRaw()).get("media", true) ?? []);
	const patchDraft = (patch: { raw?: string; prompt?: PromptDraft; storage?: string }) =>
		setDrafts((current) => ({
			...current,
			[selectedId()]: {
				...current[selectedId()],
				baseSha256: current[selectedId()]?.baseSha256 ?? props.document()?.sha256,
				...patch,
			},
		}));
	const setRaw = (value: string) => patchDraft({ raw: value });
	const setPrompt = (value: PromptDraft) => patchDraft({ prompt: value });
	const setStorage = (value: string) => patchDraft({ storage: value });
	const [parseError, setParseError] = createSignal<string>();
	const [saveError, setSaveError] = createSignal<string>();
	const [saving, setSaving] = createSignal(false);
	const trust = () => props.pluginTrustData(selectedId());
	const relationshipSettings = () => props.settingsData(selectedId());
	const [settingsSaving, setSettingsSaving] = createSignal(false);
	const [pendingDeletion, setPendingDeletion] = createSignal<"runtime" | "package">();
	const [deleting, setDeleting] = createSignal(false);
	const [deletionFeedback, setDeletionFeedback] = createSignal<string>();
	const dirty = () => raw() !== savedRaw();
	const load = (id: string) => {
		if (id === selectedId()) return;
		props.selectPackage(
			id,
			() => !dirty() || window.confirm(t("currentRolePackage.discardConfirm")),
		);
	};

	const updateRelationshipSetting = async () => {
		const current = relationshipSettings();
		const characterId = selectedId();
		if (!current || !characterId) return;
		setSettingsSaving(true);
		try {
			await props.settingsUpdate(characterId, {
				relationshipMemoryEnabled: !current.relationshipMemoryEnabled,
			});
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : String(error));
		} finally {
			setSettingsSaving(false);
		}
	};
	const enablePlugins = async () => {
		const characterId = selectedId();
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
	const updatePrompt = (field: PromptField, value: string) => {
		const current = prompt();
		if (!current) return;
		const next = { ...current, [field]: value };
		const yaml = parseDocument(raw());
		if (yaml.errors.length > 0) return;
		for (const key of PROMPT_FIELDS) yaml.setIn(["prompt", key], next[key]);
		setPrompt(next);
		setRaw(String(yaml));
		setParseError(undefined);
	};
	const updateStorage = (value: string) => {
		setStorage(value);
		const storageDocument = parseDocument(value);
		if (storageDocument.errors.length > 0) {
			setParseError(storageDocument.errors[0]?.message ?? t("currentRolePackage.invalidStorage"));
			return;
		}
		const yaml = parseDocument(raw());
		if (yaml.errors.length > 0) return;
		yaml.set("media", storageDocument.toJSON());
		setRaw(String(yaml));
		setParseError(undefined);
	};
	const discard = () => {
		const current = props.document();
		if (!current) return;
		setDrafts((drafts) => ({
			...drafts,
			[current.characterId]: {
				raw: current.yaml,
				prompt: promptFrom(current),
				storage: stringify(parseDocument(current.yaml).get("media", true) ?? []),
			},
		}));
		setParseError(undefined);
		setSaveError(undefined);
	};
	const save = async () => {
		if (!props.document() || !dirty() || parseError()) return;
		setSaving(true);
		setSaveError(undefined);
		try {
			const next = await props.savePackage(raw(), draft()?.baseSha256 ?? props.document()!.sha256);
			setDrafts((drafts) => ({
				...drafts,
				[next.characterId]: {
					raw: next.yaml,
					prompt: promptFrom(next),
					storage: stringify(parseDocument(next.yaml).get("media", true) ?? []),
				},
			}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setSaveError(
				message.includes("character_package_revision_mismatch")
					? t("currentRolePackage.conflict")
					: message,
			);
		} finally {
			setSaving(false);
		}
	};
	const deletionErrorMessage = (error: unknown): string => {
		const reason =
			typeof error === "object" && error !== null && "reason" in error ? String(error.reason) : "";
		switch (reason) {
			case "character_runtime_active":
			case "character_package_active":
				return t("currentRolePackage.deleteBlockedActive");
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
							data-selected={character.id === selectedId() || undefined}
							type="button"
							onClick={() => void load(character.id)}
						>
							{character.name}
							{character.active ? t("currentRolePackage.activeSuffix") : ""}
						</Button>
					)}
				</For>
			</section>
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
						</header>
						<Tabs defaultValue="package" class="current-role-package-tabs">
							<Tabs.List class="sub-tabs">
								<Tabs.Trigger value="package" class="tab">
									{t("currentRolePackage.packageTab")}
								</Tabs.Trigger>
								<Tabs.Trigger value="storage" class="tab">
									{t("currentRolePackage.storageTab")}
								</Tabs.Trigger>
								<Tabs.Trigger value="memory" class="tab">
									{t("currentRolePackage.memoryTab")}
								</Tabs.Trigger>
							</Tabs.List>
							<Tabs.Content value="package" class="tab-panel">
								<div class="current-role-package-form">
									<For each={PROMPT_FIELDS}>
										{(field) => (
											<TextField class="setting-field">
												<TextField.Label class="field-label">
													{t(`currentRolePackage.promptFields.${field}`)}
												</TextField.Label>
												<TextField.TextArea
													rows={field === "mes_example" ? 7 : 4}
													disabled={!current().writable}
													value={prompt()?.[field] ?? ""}
													onInput={(event) => updatePrompt(field, event.currentTarget.value)}
												/>
											</TextField>
										)}
									</For>
								</div>
							</Tabs.Content>
							<Tabs.Content value="storage" class="tab-panel">
								<div class="detail-card">
									<strong>{t("currentRolePackage.pluginTrust")}</strong>
									<span>
										{trust()?.pluginsPresent
											? `${trust()?.trusted ? t("currentRolePackage.pluginTrusted") : t("currentRolePackage.pluginDisabled")} · ${trust()?.pluginHash.slice(0, 12)}`
											: t("currentRolePackage.noPlugins")}
									</span>
									<Show when={trust()?.pluginsPresent && !trust()?.trusted}>
										<Button
											data-control="command"
											type="button"
											disabled={saving()}
											onClick={() => void enablePlugins()}
										>
											{t("currentRolePackage.enablePlugins")}
										</Button>
									</Show>
								</div>
								<TextField class="setting-field">
									<TextField.Label class="field-label">media.yaml</TextField.Label>
									<TextField.TextArea
										aria-label={t("currentRolePackage.storageDefinition")}
										rows={18}
										disabled={!current().writable}
										value={storage()}
										onInput={(event) => updateStorage(event.currentTarget.value)}
									/>
								</TextField>
								<div class="detail-card">
									<strong>{t("currentRolePackage.storyProjection")}</strong>
									<span>
										{t("currentRolePackage.projectionCounts", {
											media: current().character.media.length,
										})}
									</span>
								</div>
							</Tabs.Content>
							<Tabs.Content value="memory" class="tab-panel">
								<div class="detail-card">
									<strong>{t("currentRolePackage.relationshipMemory")}</strong>
									<span>{t("currentRolePackage.relationshipMemoryDescription")}</span>
									<Button
										type="button"
										class="switch-control"
										role="switch"
										aria-label={t("currentRolePackage.relationshipMemory")}
										aria-checked={relationshipSettings()?.relationshipMemoryEnabled || false}
										data-checked={relationshipSettings()?.relationshipMemoryEnabled || undefined}
										disabled={settingsSaving()}
										onClick={() => void updateRelationshipSetting()}
									>
										<span class="switch-thumb" />
									</Button>
								</div>
							</Tabs.Content>
						</Tabs>
						<Show when={parseError()}>
							{(message) => (
								<p class="status-line err" role="alert">
									{message()}
								</p>
							)}
						</Show>
						<Show when={saveError()}>
							{(message) => (
								<p class="status-line err" role="alert">
									{message()}
								</p>
							)}
						</Show>
						<Show when={dirty() || saving() || Boolean(saveError())}>
							<div class="current-role-package-actions">
								<span>{t("currentRolePackage.unsaved")}</span>
								<Button
									data-control="command"
									type="button"
									disabled={!dirty() || saving() || !current().writable}
									onClick={discard}
								>
									{t("currentRolePackage.discard")}
								</Button>
								<Button
									data-variant="primary"
									type="button"
									disabled={!dirty() || saving() || !current().writable || Boolean(parseError())}
									onClick={() => void save()}
								>
									{t("currentRolePackage.save")}
								</Button>
							</div>
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
									<Show when={props.deletionStatus()?.active}>
										<small>{t("currentRolePackage.deleteBlockedActive")}</small>
									</Show>
									<Show when={props.deletionStatus() && !props.deletionStatus()?.runtimePresent}>
										<small>{t("currentRolePackage.runtimeAlreadyAbsent")}</small>
									</Show>
								</div>
								<Button
									data-variant="danger"
									type="button"
									disabled={
										deleting() ||
										!props.deletionStatus() ||
										props.deletionStatus()?.active ||
										!props.deletionStatus()?.runtimePresent
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
									<Show when={props.deletionStatus()?.active}>
										<small>{t("currentRolePackage.deleteBlockedActive")}</small>
									</Show>
									<Show when={props.deletionStatus()?.default}>
										<small>{t("currentRolePackage.deleteBlockedDefault")}</small>
									</Show>
									<Show when={props.deletionStatus()?.runtimePresent}>
										<small>{t("currentRolePackage.deleteBlockedRuntimePresent")}</small>
									</Show>
									<Show when={dirty()}>
										<small>{t("currentRolePackage.deleteBlockedUnsaved")}</small>
									</Show>
								</div>
								<Button
									data-variant="danger"
									type="button"
									disabled={
										deleting() ||
										dirty() ||
										!props.deletionStatus() ||
										props.deletionStatus()?.active ||
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
