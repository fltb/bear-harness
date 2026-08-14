import { Select, Switch } from "@kobalte/core";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { useCompanionStore, type ImmersionLevel, type SettingsData } from "../stores/companion.js";

/**
 * System settings sheet (幕后 · 系统设置).
 *
 * All state comes from the reactive `store.settings.data()`; `get()` loads it
 * on mount and `set()` pushes partial patches through the store, which
 * re-reads `settings.get` so the UI always mirrors the host's canonical
 * state. The store normalizes hostile payloads at the boundary.
 */

interface SettingsOption<T extends string> {
	value: T;
	label: string;
}

const IMMERSION_OPTIONS: SettingsOption<ImmersionLevel>[] = [
	{ value: "concise", label: "简洁" },
	{ value: "roleplay", label: "角色扮演" },
	{ value: "narrative", label: "叙事" },
];

const THEME_OPTIONS: SettingsOption<string>[] = [
	{ value: "aurora", label: "极光 · 默认" },
	{ value: "night", label: "夜灯" },
	{ value: "paper", label: "纸页" },
];


const DEFAULT_SETTINGS: SettingsData = {
	relationshipMemoryEnabled: false,
	pauseLearning: false,
	immersionLevel: "concise",
	currentScene: "",
	theme: "",
};

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/** Kobalte Select styled for the sheet; single-select over string options. */
function FieldSelect<T extends string>(props: {
	label: string;
	options: SettingsOption<T>[];
	selected: SettingsOption<T> | null;
	placeholder: string;
	disabled?: boolean;
	onChange: (value: T) => void;
}) {
	return (
		<Select.Root
			class="field"
			options={props.options}
			optionValue="value"
			optionTextValue="label"
			value={props.selected}
			placeholder={props.placeholder}
			disabled={props.disabled}
			onChange={(option) => {
				if (option) props.onChange(option.value);
			}}
			itemComponent={(selectItem) => (
				<Select.Item item={selectItem.item} class="select-option">
					<Select.ItemLabel>{selectItem.item.rawValue.label}</Select.ItemLabel>
					<Select.ItemIndicator class="select-check" aria-hidden="true">
						✓
					</Select.ItemIndicator>
				</Select.Item>
			)}
		>
			<Select.Label class="field-label">{props.label}</Select.Label>
			<Select.Trigger class="select-trigger" aria-label={props.label}>
				<Select.Value<SettingsOption<T>> class="select-value">
					{(state) => state.selectedOption()?.label ?? props.placeholder}
				</Select.Value>
				<Select.Icon class="select-icon" aria-hidden="true">
					▾
				</Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Content class="select-content">
					<Select.Listbox class="select-listbox" />
				</Select.Content>
			</Select.Portal>
		</Select.Root>
	);
}

export function SettingsSheet() {
	const store = useCompanionStore();
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);

	const settings = () => store.settings.data() ?? DEFAULT_SETTINGS;
	const loading = () => store.settings.data() === undefined;

	createEffect(() => {
		void store.settings.get();
	});

	async function save(patch: Partial<SettingsData>, success: string): Promise<void> {
		setSaving(true);
		setError(null);
		setFeedback(null);
		try {
			await store.settings.set(patch);
			setFeedback(success);
		} catch (e) {
			setError(messageOf(e));
		} finally {
			setSaving(false);
		}
	}

	const disabled = () => saving() || loading();
	const sceneOptions = createMemo<SettingsOption<string>[]>(() =>
		store.character?.scenes.map((scene) => ({ value: scene.id, label: scene.label })) ?? [],
	);

	return (
		<div class="sheet-panel">
			<p class="drawer-note">管理应用行为。角色称呼、关系和表达方式不在这里修改。</p>
			<Show when={loading()}>
				<p class="empty-note">正在读取…</p>
			</Show>
			<Show when={feedback()}>
				<p class="status-line ok" role="status">
					{feedback()}
				</p>
			</Show>
			<Show when={error()}>
				<p class="status-line err" role="alert">
					{error()}
				</p>
			</Show>

			<div class="field">
				<Switch.Root
					class="switch-field"
					checked={settings().relationshipMemoryEnabled}
					disabled={disabled()}
					onChange={(checked) =>
						save(
							{ relationshipMemoryEnabled: checked },
							checked ? "关系记忆已开启" : "关系记忆已关闭",
						)
					}
				>
					<div class="switch-text">
						<Switch.Label class="field-label">关系记忆</Switch.Label>
						<p class="field-hint">记住你明确确认的称呼、偏好与共同经历；不会把工作文件内容写进记忆。</p>
					</div>
					<Switch.Control class="switch-control">
						<Switch.Thumb class="switch-thumb" />
					</Switch.Control>
					<Switch.Input />
				</Switch.Root>
			</div>

			<FieldSelect
				label="沉浸程度"
				options={IMMERSION_OPTIONS}
				selected={IMMERSION_OPTIONS.find((option) => option.value === settings().immersionLevel) ?? null}
				placeholder="选择沉浸程度"
				disabled={disabled()}
				onChange={(value) => save({ immersionLevel: value }, "已保存沉浸程度")}
			/>
			<FieldSelect
				label="当前场景"
				options={sceneOptions()}
				selected={sceneOptions().find((option) => option.value === settings().currentScene) ?? null}
				placeholder="选择场景"
				disabled={disabled() || sceneOptions().length === 0}
				onChange={(value) => save({ currentScene: value }, "已切换场景")}
			/>
			<FieldSelect
				label="主题"
				options={THEME_OPTIONS}
				selected={THEME_OPTIONS.find((option) => option.value === settings().theme) ?? null}
				placeholder="选择主题"
				disabled={disabled()}
				onChange={(value) => save({ theme: value }, "已保存主题选择")}
			/>
			<p class="drawer-note theme-note">主题切换即将到来：当前只保存你的选择，界面外观暂时不变。</p>
		</div>
	);
}
