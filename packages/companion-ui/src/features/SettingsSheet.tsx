import { productUi } from "@bear-harness/product-config";
import { Select } from "@kobalte/core";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { type ImmersionLevel, type SettingsData, useCompanionStore } from "../stores/companion.js";

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

const IMMERSION_OPTIONS: SettingsOption<ImmersionLevel>[] = [...productUi.settings.immersion];

const THEME_OPTIONS: SettingsOption<string>[] = [...productUi.settings.themes];

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
	const sceneOptions = createMemo<SettingsOption<string>[]>(
		() => store.character?.scenes.map((scene) => ({ value: scene.id, label: scene.label })) ?? [],
	);

	return (
		<div class="sheet-panel">
			<p class="drawer-note">{productUi.settings.note}</p>
			<Show when={loading()}>
				<p class="empty-note">{productUi.settings.loading}</p>
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
				<div class="switch-field">
					<div class="switch-text">
						<span class="field-label">{productUi.settings.relationshipMemory}</span>
						<p class="field-hint">{productUi.settings.relationshipMemoryHint}</p>
					</div>
					<button
						type="button"
						class="switch-control"
						role="switch"
						aria-checked={settings().relationshipMemoryEnabled}
						data-checked={settings().relationshipMemoryEnabled || undefined}
						disabled={disabled()}
						onClick={() => {
							const enabled = !settings().relationshipMemoryEnabled;
							void save(
								{ relationshipMemoryEnabled: enabled },
								enabled
									? productUi.settings.relationshipMemoryEnabled
									: productUi.settings.relationshipMemoryDisabled,
							);
						}}
					>
						<span class="switch-thumb" />
					</button>
				</div>
			</div>

			<FieldSelect
				label={productUi.settings.immersionLabel}
				options={IMMERSION_OPTIONS}
				selected={
					IMMERSION_OPTIONS.find((option) => option.value === settings().immersionLevel) ?? null
				}
				placeholder={productUi.settings.immersionPlaceholder}
				disabled={disabled()}
				onChange={(value) => save({ immersionLevel: value }, productUi.settings.immersionSaved)}
			/>
			<FieldSelect
				label={productUi.settings.sceneLabel}
				options={sceneOptions()}
				selected={sceneOptions().find((option) => option.value === settings().currentScene) ?? null}
				placeholder={productUi.settings.scenePlaceholder}
				disabled={disabled() || sceneOptions().length === 0}
				onChange={(value) => save({ currentScene: value }, productUi.settings.sceneSaved)}
			/>
			<FieldSelect
				label={productUi.settings.themeLabel}
				options={THEME_OPTIONS}
				selected={THEME_OPTIONS.find((option) => option.value === settings().theme) ?? null}
				placeholder={productUi.settings.themePlaceholder}
				disabled={disabled()}
				onChange={(value) => save({ theme: value }, productUi.settings.themeSaved)}
			/>
			<p class="drawer-note theme-note">{productUi.settings.themeNote}</p>
		</div>
	);
}
