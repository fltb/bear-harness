import { i18n, useTranslation } from "@bear-harness/i18n";
import { createSignal, For, Show } from "solid-js";
import { parseDocument } from "yaml";
import type { CharacterDeletionStatus, CharacterPackageDocument } from "../stores/companion.js";
import { Button, Dialog, TextField } from "../ui/primitives.js";

const PROMPT_FIELDS = ["description", "personality", "scenario", "system_prompt"] as const;
type PromptField = (typeof PROMPT_FIELDS)[number];

type PromptDraft = Record<PromptField, string>;

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
	characters: () => Array<{ id: string; name: string; active: boolean }>;
	selectedId: () => string | undefined;
	document: () => CharacterPackageDocument | undefined;
	loading: () => boolean;
	error: () => string | undefined;
	selectPackage: (id: string, confirmDiscard: () => boolean) => void;
	savePackage: (yaml: string, expectedSha256: string) => Promise<CharacterPackageDocument>;
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
	const [drafts, setDrafts] = createSignal<
		Record<string, { prompt: PromptDraft; baseSha256: string }>
	>({});
	const draft = () => drafts()[documentId()];
	const prompt = (): PromptDraft =>
		draft()?.prompt ??
		props.document()?.character.prompt ?? {
			description: "",
			personality: "",
			scenario: "",
			system_prompt: "",
		};
	const updatePrompt = (field: PromptField, value: string) => {
		const current = props.document();
		if (!current) return;
		setDrafts((drafts) => {
			const existing = drafts[current.characterId];
			return {
				...drafts,
				[current.characterId]: {
					baseSha256: existing?.baseSha256 ?? current.sha256,
					prompt: {
						...(existing?.prompt ?? current.character.prompt),
						[field]: value,
					},
				},
			};
		});
	};
	const [parseError, setParseError] = createSignal<string>();
	const [saveError, setSaveError] = createSignal<string>();
	const [revealError, setRevealError] = createSignal<string>();
	const [saving, setSaving] = createSignal(false);
	const trust = () => props.pluginTrustData(documentId());
	const [pendingDeletion, setPendingDeletion] = createSignal<"runtime" | "package">();
	const [deleting, setDeleting] = createSignal(false);
	const [deletionFeedback, setDeletionFeedback] = createSignal<string>();
	const dirty = () => {
		const current = props.document();
		return Boolean(
			current && PROMPT_FIELDS.some((field) => prompt()[field] !== current.character.prompt[field]),
		);
	};
	const load = (id: string) => {
		if (id === props.selectedId()) return;
		props.selectPackage(
			id,
			() => !dirty() || window.confirm(t("currentRolePackage.discardConfirm")),
		);
	};

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
	const discard = () => {
		const current = props.document();
		if (!current) return;
		setDrafts((drafts) => {
			const next = { ...drafts };
			delete next[current.characterId];
			return next;
		});
		setParseError(undefined);
		setSaveError(undefined);
	};
	const save = async () => {
		const current = props.document();
		if (!current || !dirty() || parseError()) return;
		setSaving(true);
		setSaveError(undefined);
		try {
			const yaml = parseDocument(current.yaml);
			if (yaml.errors.length > 0) {
				setParseError(yaml.errors[0]?.message ?? t("currentRolePackage.invalidStorage"));
				return;
			}
			for (const field of PROMPT_FIELDS) yaml.setIn(["prompt", field], prompt()[field]);
			const next = await props.savePackage(String(yaml), draft()?.baseSha256 ?? current.sha256);
			setDrafts((drafts) => ({
				...drafts,
				[next.characterId]: {
					baseSha256: next.sha256,
					prompt: { ...next.character.prompt },
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
						<fieldset class="detail-card current-role-prompt-editor">
							<legend>{t("currentRolePackage.promptEditor")}</legend>
							<p class="field-hint">{t("currentRolePackage.promptEditorDescription")}</p>
							<For each={PROMPT_FIELDS}>
								{(field) => (
									<TextField
										value={prompt()[field]}
										disabled={!current().writable}
										class="prompt-field"
									>
										<TextField.Label>
											{t(`currentRolePackage.promptFields.${field}`)}
										</TextField.Label>
										<TextField.TextArea
											class="prompt-textarea"
											rows={field === "system_prompt" ? 7 : 4}
											onInput={(event) => updatePrompt(field, event.currentTarget.value)}
										/>
									</TextField>
								)}
							</For>
						</fieldset>
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
