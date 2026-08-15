import { productUi } from "@bear-harness/product-config";
import { createEffect, createSignal, Show } from "solid-js";
import { type SettingsData, useCompanionStore } from "../stores/companion.js";

/**
 * System settings sheet (幕后 · 系统设置).
 *
 * All state comes from the reactive `store.settings.data()`; `get()` loads it
 * on mount and `set()` pushes partial patches through the store, which
 * re-reads `settings.get` so the UI always mirrors the host's canonical
 * state. The store normalizes hostile payloads at the boundary.
 */

const DEFAULT_SETTINGS: SettingsData = {
	relationshipMemoryEnabled: false,
};

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
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
		</div>
	);
}
