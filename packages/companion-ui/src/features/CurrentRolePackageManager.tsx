import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Tabs } from "@kobalte/core/tabs";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, For, Show } from "solid-js";
import { parseDocument, stringify } from "yaml";
import {
	type CharacterPackageDocument,
	type MemoryCandidate,
	useCompanionStore,
} from "../stores/companion.js";
import { MemoryEntryList } from "./MemorySheet.js";

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
	settingsData: (
		id: string,
	) => { relationshipMemoryEnabled: boolean; conversationHistoryReadEnabled: boolean } | undefined;
	memoryCandidates: (id: string) => MemoryCandidate[];
	confirmPluginTrust: (id: string) => Promise<void>;
	settingsGet: (
		id: string,
	) => Promise<{ relationshipMemoryEnabled: boolean; conversationHistoryReadEnabled: boolean }>;
	settingsUpdate: (
		id: string,
		settings: { relationshipMemoryEnabled?: boolean; conversationHistoryReadEnabled?: boolean },
	) => Promise<void>;
	listMemoryCandidates: (id: string) => Promise<MemoryCandidate[]>;
	approveMemoryCandidate: (id: string, candidateId: string) => Promise<void>;
	rejectMemoryCandidate: (id: string, candidateId: string) => Promise<void>;
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
		draft()?.storage ?? stringify(parseDocument(savedRaw()).get("roleplay", true) ?? {});
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
	const dirty = () => raw() !== savedRaw();
	const load = (id: string) => {
		if (id === selectedId()) return;
		props.selectPackage(
			id,
			() => !dirty() || window.confirm(t("currentRolePackage.discardConfirm")),
		);
	};

	const updateRelationshipSetting = async (
		key: "relationshipMemoryEnabled" | "conversationHistoryReadEnabled",
	) => {
		const current = relationshipSettings();
		const characterId = selectedId();
		if (!current || !characterId) return;
		setSettingsSaving(true);
		try {
			const next = { ...current, [key]: !current[key] };
			await props.settingsUpdate(characterId, { [key]: next[key] });
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
		yaml.set("roleplay", storageDocument.toJSON());
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
				storage: stringify(parseDocument(current.yaml).get("roleplay", true) ?? {}),
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
					storage: stringify(parseDocument(next.yaml).get("roleplay", true) ?? {}),
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
									<TextField.Label class="field-label">roleplay.yaml</TextField.Label>
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
											variables: current().character.roleplay.variables.length,
											unlockables: current().character.roleplay.unlockables.length,
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
										onClick={() => void updateRelationshipSetting("relationshipMemoryEnabled")}
									>
										<span class="switch-thumb" />
									</Button>
								</div>
								<div class="detail-card">
									<strong>{t("currentRolePackage.readConversationHistory")}</strong>
									<span>{t("currentRolePackage.readConversationHistoryDescription")}</span>
									<Button
										type="button"
										class="switch-control"
										role="switch"
										aria-label={t("currentRolePackage.readConversationHistory")}
										aria-checked={relationshipSettings()?.conversationHistoryReadEnabled || false}
										data-checked={
											relationshipSettings()?.conversationHistoryReadEnabled || undefined
										}
										disabled={settingsSaving()}
										onClick={() => void updateRelationshipSetting("conversationHistoryReadEnabled")}
									>
										<span class="switch-thumb" />
									</Button>
								</div>
								<RoleRelationshipCandidates
									characterId={current().characterId}
									list={props.listMemoryCandidates}
									data={props.memoryCandidates}
									approve={props.approveMemoryCandidate}
									reject={props.rejectMemoryCandidate}
								/>
								<MemoryEntryList
									scope="relationship"
									title={t("currentRolePackage.relationshipMemoryTitle")}
									characterId={current().characterId}
								/>
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
					</>
				)}
			</Show>
		</section>
	);
}

function RoleRelationshipCandidates(props: {
	characterId: string;
	list: (characterId: string) => Promise<MemoryCandidate[]>;
	data: (characterId: string) => MemoryCandidate[];
	approve: (characterId: string, candidateId: string) => Promise<void>;
	reject: (characterId: string, candidateId: string) => Promise<void>;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const projection = useCompanionStore().memory.observeCandidates(
		() => props.characterId,
		"pending",
	);
	const candidates = () =>
		(projection.data()?.candidates ?? []).filter(
			(candidate) => candidate.suggestedScope === "relationship",
		);
	const [error, setError] = createSignal<string>();
	const [busyId, setBusyId] = createSignal<string>();
	const reload = async () => {
		try {
			setError(undefined);
			await props.list(props.characterId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const decide = async (candidateId: string, decision: "approve" | "reject") => {
		setBusyId(candidateId);
		try {
			if (decision === "approve") await props.approve(props.characterId, candidateId);
			else await props.reject(props.characterId, candidateId);
			await reload();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusyId(undefined);
		}
	};
	return (
		<section class="memory-section" aria-label={t("currentRolePackage.pendingRelationshipLabel")}>
			<div class="section-head">
				<h3>{t("currentRolePackage.pendingRelationshipTitle")}</h3>
			</div>
			<Show when={error()}>
				{(message) => (
					<p class="status-line err" role="alert">
						{message()}
					</p>
				)}
			</Show>
			<Show when={candidates().length === 0}>
				<p class="empty-note">{t("currentRolePackage.noPendingRelationship")}</p>
			</Show>
			<ul class="candidate-list">
				<For each={candidates()}>
					{(candidate) => (
						<li class="candidate-card">
							<p class="candidate-text">{candidate.normalizedText}</p>
							<p class="candidate-why">{candidate.why}</p>
							<div class="candidate-actions">
								<Button
									type="button"
									class="mini-btn primary"
									disabled={busyId() === candidate.id}
									onClick={() => void decide(candidate.id, "approve")}
								>
									{t("currentRolePackage.keep")}
								</Button>
								<Button
									type="button"
									class="mini-btn"
									disabled={busyId() === candidate.id}
									onClick={() => void decide(candidate.id, "reject")}
								>
									{t("currentRolePackage.ignore")}
								</Button>
							</div>
						</li>
					)}
				</For>
			</ul>
		</section>
	);
}
