import { i18n, useTranslation } from "@bear-harness/i18n";
import { createSignal, For, Show } from "solid-js";
import { parseDocument, stringify } from "yaml";
import type { CharacterDeletionStatus, CharacterPackageDocument } from "../stores/companion.js";
import { Button, Dialog, TextField } from "../ui/primitives.js";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function ManifestField(props: {
	name: string;
	path: string[];
	schema: unknown;
	value: unknown;
	disabled: boolean;
	onChange(path: string[], value: unknown): void;
	onInvalid(message: string): void;
}) {
	const schema = () => record(props.schema) ?? {};
	const properties = () => record(schema().properties);
	const type = () => schema().type;
	return (
		<Show
			when={properties()}
			fallback={
				<Show
					when={Array.isArray(props.value) || type() === "array"}
					fallback={
						<Show
							when={typeof props.value === "boolean" || type() === "boolean"}
							fallback={
								<TextField class="setting-field manifest-field">
									<TextField.Label class="field-label">{props.name}</TextField.Label>
									<Show
										when={typeof props.value === "string" && props.value.includes("\n")}
										fallback={
											<TextField.Input
												disabled={props.disabled}
												value={props.value == null ? "" : String(props.value)}
												onInput={(event) =>
													props.onChange(
														props.path,
														type() === "number" || type() === "integer"
															? Number(event.currentTarget.value)
															: event.currentTarget.value,
													)
												}
											/>
										}
									>
										<TextField.TextArea
											rows={4}
											disabled={props.disabled}
											value={String(props.value ?? "")}
											onInput={(event) => props.onChange(props.path, event.currentTarget.value)}
										/>
									</Show>
								</TextField>
							}
						>
							<div class="setting-field manifest-field">
								<span class="field-label">{props.name}</span>
								<Button
									type="button"
									aria-pressed={Boolean(props.value)}
									disabled={props.disabled}
									onClick={() => props.onChange(props.path, !props.value)}
								>
									{String(Boolean(props.value))}
								</Button>
							</div>
						</Show>
					}
				>
					<TextField class="setting-field manifest-field manifest-array-field">
						<TextField.Label class="field-label">{props.name}</TextField.Label>
						<TextField.TextArea
							rows={Math.min(
								12,
								Math.max(3, Array.isArray(props.value) ? props.value.length * 2 : 3),
							)}
							disabled={props.disabled}
							value={stringify(props.value ?? [])}
							onInput={(event) => {
								const parsed = parseDocument(event.currentTarget.value);
								if (parsed.errors[0]) props.onInvalid(parsed.errors[0].message);
								else props.onChange(props.path, parsed.toJSON());
							}}
						/>
					</TextField>
				</Show>
			}
		>
			{(fields) => (
				<fieldset class="manifest-object-field">
					<legend>{props.name}</legend>
					<For each={Object.entries(fields())}>
						{([name, childSchema]) => (
							<ManifestField
								name={name}
								path={[...props.path, name]}
								schema={childSchema}
								value={record(props.value)?.[name]}
								disabled={props.disabled}
								onChange={props.onChange}
								onInvalid={props.onInvalid}
							/>
						)}
					</For>
				</fieldset>
			)}
		</Show>
	);
}

export function CurrentRolePackageManager(props: {
	characters: () => Array<{ id: string; name: string; active: boolean }>;
	selectedId: () => string | undefined;
	document: () => CharacterPackageDocument | undefined;
	loading: () => boolean;
	error: () => string | undefined;
	selectPackage: (id: string, confirmDiscard: () => boolean) => void;
	savePackage: (yaml: string, expectedSha256: string) => Promise<CharacterPackageDocument>;
	revealPackage: (id: string) => Promise<void>;
	pluginTrust: (
		id: string,
	) => Promise<{ origin: string; pluginHash: string; pluginsPresent: boolean; trusted: boolean }>;
	pluginTrustData: (
		id: string,
	) =>
		| { origin: string; pluginHash: string; pluginsPresent: boolean; trusted: boolean }
		| undefined;
	confirmPluginTrust: (id: string) => Promise<void>;
	deletionStatus: () => CharacterDeletionStatus | undefined;
	deletionStatusLoading: () => boolean;
	deletionStatusError: () => string | undefined;
	deleteRuntime: (id: string) => Promise<{ deleted: boolean }>;
	deletePackage: (id: string) => Promise<{ deleted: boolean }>;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const selectedId = () => props.document()?.characterId ?? "";
	const [drafts, setDrafts] = createSignal<Record<string, { raw?: string; baseSha256?: string }>>(
		{},
	);
	const draft = () => drafts()[selectedId()];
	const raw = () => draft()?.raw ?? props.document()?.yaml ?? "";
	const savedRaw = () => props.document()?.yaml ?? "";
	const patchDraft = (patch: { raw?: string }) =>
		setDrafts((current) => ({
			...current,
			[selectedId()]: {
				...current[selectedId()],
				baseSha256: current[selectedId()]?.baseSha256 ?? props.document()?.sha256,
				...patch,
			},
		}));
	const setRaw = (value: string) => patchDraft({ raw: value });
	const manifest = () => {
		const document = parseDocument(raw());
		return document.errors.length ? undefined : document.toJSON();
	};
	const [parseError, setParseError] = createSignal<string>();
	const [saveError, setSaveError] = createSignal<string>();
	const [saving, setSaving] = createSignal(false);
	const trust = () => props.pluginTrustData(selectedId());
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
	const updateManifest = (path: string[], value: unknown) => {
		const yaml = parseDocument(raw());
		if (yaml.errors.length > 0) {
			setParseError(yaml.errors[0]?.message ?? t("currentRolePackage.invalidStorage"));
			return;
		}
		yaml.setIn(path, value);
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
							<Button type="button" onClick={() => void props.revealPackage(current().characterId)}>
								{t("currentRolePackage.revealPackage")}
							</Button>
						</header>
						<div class="detail-card">
							<strong>{t("currentRolePackage.pluginTrust")}</strong>
							<span>
								{trust()?.pluginsPresent
									? `${trust()?.trusted ? t("currentRolePackage.pluginTrusted") : t("currentRolePackage.pluginDisabled")} · ${trust()?.pluginHash.slice(0, 12)}`
									: t("currentRolePackage.noPlugins")}
							</span>
							<Show when={trust()?.pluginsPresent && !trust()?.trusted}>
								<Button type="button" disabled={saving()} onClick={() => void enablePlugins()}>
									{t("currentRolePackage.enablePlugins")}
								</Button>
							</Show>
						</div>
						<Show when={manifest()}>
							{(value) => (
								<ManifestField
									name={t("currentRolePackage.manifest")}
									path={[]}
									schema={current().manifestSchema}
									value={value()}
									disabled={!current().writable}
									onChange={updateManifest}
									onInvalid={(message) => setParseError(message)}
								/>
							)}
						</Show>
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
