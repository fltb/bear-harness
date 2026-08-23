import { Button } from "@kobalte/core/button";
import { Tabs } from "@kobalte/core/tabs";
import { For, Show, createEffect, createSignal } from "solid-js";
import { parseDocument } from "yaml";
import type { CharacterPackageDocument } from "../stores/companion.js";
import { MemorySheet } from "./MemorySheet.js";

const PROMPT_FIELDS = ["description", "personality", "scenario", "system_prompt", "mes_example"] as const;
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
	savePackage: (yaml: string) => Promise<CharacterPackageDocument>;
	pluginTrust: (id: string) => Promise<{ origin: string; pluginHash: string; pluginsPresent: boolean; trusted: boolean }>;
}) {
	const [selectedId, setSelectedId] = createSignal("");
	const [raw, setRaw] = createSignal("");
	const [savedRaw, setSavedRaw] = createSignal("");
	const [prompt, setPrompt] = createSignal<PromptDraft>();
	const [parseError, setParseError] = createSignal<string>();
	const [saveError, setSaveError] = createSignal<string>();
	const [saving, setSaving] = createSignal(false);
	const [trust, setTrust] = createSignal<{ origin: string; pluginHash: string; pluginsPresent: boolean; trusted: boolean }>();
	let request = 0;
	const dirty = () => raw() !== savedRaw();
	const load = (id: string) => {
		if (id === selectedId()) return;
		props.selectPackage(id, () => !dirty() || window.confirm("Discard unsaved character package edits?"));
	};
	createEffect(() => {
		const next = props.document();
		if (!next || next.characterId === selectedId()) return;
		setSelectedId(next.characterId);
		setRaw(next.yaml);
		setSavedRaw(next.yaml);
		setPrompt(promptFrom(next));
		void props.pluginTrust(next.characterId).then(setTrust);
	});
	const updatePrompt = (field: PromptField, value: string) => {
		const next = { ...prompt()!, [field]: value };
		const yaml = parseDocument(raw());
		if (yaml.errors.length > 0) return;
		for (const key of PROMPT_FIELDS) yaml.setIn(["prompt", key], next[key]);
		setPrompt(next);
		setRaw(String(yaml));
		setParseError(undefined);
	};
	const updateRaw = (value: string) => {
		setRaw(value);
		const yaml = parseDocument(value);
		if (yaml.errors.length > 0) {
			setParseError(yaml.errors[0]!.message);
			return;
		}
		const promptValue = yaml.get("prompt", true);
		if (!promptValue || typeof promptValue !== "object" || Array.isArray(promptValue)) {
			setParseError("prompt must be an object");
			return;
		}
		const candidate = promptValue as Partial<PromptDraft>;
		if (!PROMPT_FIELDS.every((key) => typeof candidate[key] === "string")) {
			setParseError("prompt must contain five string fields");
			return;
		}
		setPrompt(candidate as PromptDraft);
		setParseError(undefined);
	};
	const discard = () => {
		const current = document();
		if (!current) return;
		setRaw(current.yaml);
		setSavedRaw(current.yaml);
		setPrompt(promptFrom(current));
		setParseError(undefined);
		setSaveError(undefined);
	};
	const save = async () => {
		if (!document() || !dirty() || parseError()) return;
		setSaving(true);
		setSaveError(undefined);
		try {
			const next = await props.savePackage(raw());
			setRaw(next.yaml);
			setSavedRaw(next.yaml);
			setPrompt(promptFrom(next));
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};
	return <section class="current-role-package-manager">
		<div class="current-role-package-selector" aria-label="本地角色库">
			<For each={props.characters()}>{(character) => <Button data-control="command" class="current-role-package-choice" data-selected={character.id === selectedId() || undefined} type="button" onClick={() => void load(character.id)}>{character.name}{character.active ? " · 当前" : ""}</Button>}</For>
		</div>
		<Show when={document()}>{(current) => <>
			<header class="current-role-package-summary"><div><strong>{current().character.name}</strong><span>{current().character.character.subtitle}</span></div><dl><dt>本地来源</dt><dd>{current().origin}</dd><dt>写入</dt><dd>{current().writable ? "可写" : "不可写"}</dd><dt>修订</dt><dd><code>{current().sha256.slice(0, 12)}</code></dd></dl></header>
			<Tabs defaultValue="package" class="current-role-package-tabs"><Tabs.List class="sub-tabs"><Tabs.Trigger value="package" class="tab">角色包本体</Tabs.Trigger><Tabs.Trigger value="storage" class="tab">角色包存储</Tabs.Trigger><Tabs.Trigger value="memory" class="tab">角色记忆</Tabs.Trigger></Tabs.List>
				<Tabs.Content value="package" class="tab-panel"><div class="current-role-package-form"><For each={PROMPT_FIELDS}>{(field) => <label class="field"><span class="field-label">prompt.{field}</span><textarea rows={field === "mes_example" ? 7 : 4} value={prompt()?.[field] ?? ""} onInput={(event) => updatePrompt(field, event.currentTarget.value)} /></label>}</For><label class="field"><span class="field-label">character.yaml</span><textarea aria-label="character.yaml" rows={18} value={raw()} onInput={(event) => updateRaw(event.currentTarget.value)} /></label></div></Tabs.Content>
				<Tabs.Content value="storage" class="tab-panel"><div class="detail-card"><strong>插件信任</strong><span>{trust()?.pluginsPresent ? `${trust()?.trusted ? "已信任" : "未启用"} · ${trust()?.pluginHash.slice(0, 12)}` : "没有角色插件"}</span></div><div class="detail-card"><strong>剧情投影</strong><span>变量 {current().character.roleplay.variables.length} · 解锁项 {current().character.roleplay.unlockables.length}</span></div></Tabs.Content>
				<Tabs.Content value="memory" class="tab-panel"><p class="drawer-note">记忆 API 当前仅投影正在相处的角色。</p><Show when={props.characters().find((character) => character.id === selectedId())?.active} fallback={<p class="empty-note">请先切换到该角色后查看其记忆。</p>}><MemorySheet /></Show></Tabs.Content>
			</Tabs>
			<Show when={parseError()}>{(message) => <p class="status-line err" role="alert">{message()}</p>}</Show><Show when={saveError()}>{(message) => <p class="status-line err" role="alert">{message()}</p>}</Show>
			<div class="current-role-package-actions"><span>{dirty() ? "有未保存的编辑" : "已与 Host 角色包对齐"}</span><Button data-control="command" type="button" disabled={!dirty() || saving()} onClick={discard}>丢弃</Button><Button data-variant="primary" type="button" disabled={!dirty() || saving() || Boolean(parseError())} onClick={() => void save()}>保存</Button></div>
		</>}</Show>
	</section>;
}
