import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, onMount, Show } from "solid-js";
import { useCompanionStore } from "../stores/companion.js";

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

const PROXY_MODES = ["direct", "auto", "manual"] as const;
const VECTOR_PROVIDERS = ["none", "remote", "local"] as const;
const VECTOR_PRESETS = [
	{ value: "BAAI/bge-m3", label: "BGE-M3（1024 维）", dimensions: 1024 },
	{ value: "Qwen/Qwen3-Embedding-8B", label: "Qwen3-Embedding-8B（1024 维）", dimensions: 1024 },
	{ value: "text-embedding-v4", label: "通义 text-embedding-v4（1024 维）", dimensions: 1024 },
	{ value: "text-embedding-3-small", label: "text-embedding-3-small（1536 维）", dimensions: 1536 },
] as const;

/**
 * Product network / memory-vector / download-mirror settings. These are
 * app-level settings persisted in the app_settings row; changing the vector
 * service or the mirror requires a restart, while the proxy applies live.
 */
export function NetworkAndMemorySettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const current = () => store.settings.data() ?? {};

	const [proxyMode, setProxyMode] = createSignal<"direct" | "auto" | "manual">("direct");
	const [proxyUrl, setProxyUrl] = createSignal("");
	const [vectorEnabled, setVectorEnabled] = createSignal(false);
	const [vectorProvider, setVectorProvider] = createSignal<"none" | "remote" | "local">("none");
	const [remoteBaseUrl, setRemoteBaseUrl] = createSignal("");
	const [remoteApiKey, setRemoteApiKey] = createSignal("");
	const [remoteModel, setRemoteModel] = createSignal("");
	const [remoteDimensions, setRemoteDimensions] = createSignal(1024);
	const [mirrorEndpoint, setMirrorEndpoint] = createSignal("");
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);

	onMount(() => {
		const snap = current() as {
			networkProxy?: { mode?: string; url?: string };
			memoryVectorService?: {
				enabled?: boolean;
				provider?: string;
				baseUrl?: string;
				apiKey?: string;
				model?: string;
				dimensions?: number;
			};
			modelDownloadMirror?: { endpoint?: string };
		};
		const proxy = snap.networkProxy;
		if (proxy) {
			if (proxy.mode === "auto" || proxy.mode === "manual") setProxyMode(proxy.mode);
			if (proxy.url) setProxyUrl(proxy.url);
		}
		const vec = snap.memoryVectorService;
		if (vec) {
			setVectorEnabled(vec.enabled ?? false);
			if (vec.provider === "remote" || vec.provider === "local") setVectorProvider(vec.provider);
			if (vec.baseUrl) setRemoteBaseUrl(vec.baseUrl);
			if (vec.apiKey) setRemoteApiKey(vec.apiKey);
			if (vec.model) setRemoteModel(vec.model);
			if (vec.dimensions) setRemoteDimensions(vec.dimensions);
		}
		const mirror = snap.modelDownloadMirror?.endpoint;
		if (mirror) setMirrorEndpoint(mirror);
	});

	async function save(): Promise<void> {
		setSaving(true);
		setError(null);
		setFeedback(null);
		try {
			await store.settings.set({
				networkProxy: {
					mode: proxyMode(),
					...(proxyMode() === "manual" && proxyUrl().trim()
						? { url: proxyUrl().trim() }
						: {}),
				},
				memoryVectorService: {
					enabled: vectorEnabled(),
					provider: vectorProvider(),
					baseUrl: vectorProvider() === "remote" ? remoteBaseUrl().trim() : undefined,
					apiKey: vectorProvider() === "remote" ? remoteApiKey().trim() : undefined,
					model: vectorProvider() === "remote" ? remoteModel().trim() : undefined,
					dimensions: vectorProvider() === "remote" ? remoteDimensions() : undefined,
				},
				modelDownloadMirror: {
					endpoint: mirrorEndpoint().trim() ? mirrorEndpoint().trim() : undefined,
				},
			});
			setFeedback(t("settings.saved"));
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSaving(false);
		}
	}

	return (
		<section class="net-settings" aria-label={t("settings.networkSection")}>
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

			<h4>{t("settings.networkSection")}</h4>
			<Select
				options={[...PROXY_MODES]}
				value={proxyMode()}
				optionTextValue={(mode) => t(`settings.proxyModes.${mode}`)}
				onChange={(mode) => mode && setProxyMode(mode)}
				placeholder={t("settings.proxyMode")}
				aria-label={t("settings.proxyMode")}
				itemComponent={(props) => (
					<Select.Item item={props.item} class="select-item">
						<Select.ItemLabel>{props.item.rawValue}</Select.ItemLabel>
					</Select.Item>
				)}
			>
				<Select.Trigger class="select-trigger" aria-label={t("settings.proxyMode")}>
					<Select.Value<"direct" | "auto" | "manual">>
						{(state) => t(`settings.proxyModes.${state.selectedOption()}`)}
					</Select.Value>
				</Select.Trigger>
			</Select>
			<Show when={proxyMode() === "manual"}>
				<TextField class="setting-field">
					<TextField.Label>{t("settings.proxyUrl")}</TextField.Label>
					<TextField.Input
						type="text"
						placeholder="http://127.0.0.1:7890"
						value={proxyUrl()}
						onInput={(event) => setProxyUrl(event.currentTarget.value)}
					/>
				</TextField>
			</Show>

			<h4>{t("settings.memoryVectorSection")}</h4>
			<div class="setting-row">
				<label class="checkbox-row">
					<input
						type="checkbox"
						checked={vectorEnabled()}
						onChange={(event) => setVectorEnabled(event.currentTarget.checked)}
					/>
					<span>{t("settings.memoryVectorEnabled")}</span>
				</label>
			</div>
			<Show when={vectorEnabled()}>
				<Select
					options={[...VECTOR_PROVIDERS]}
					value={vectorProvider()}
					optionTextValue={(provider) => t(`settings.vectorProviders.${provider}`)}
					onChange={(provider) => provider && setVectorProvider(provider)}
					placeholder={t("settings.vectorProvider")}
					aria-label={t("settings.vectorProvider")}
					itemComponent={(props) => (
						<Select.Item item={props.item} class="select-item">
							<Select.ItemLabel>{props.item.rawValue}</Select.ItemLabel>
						</Select.Item>
					)}
				>
					<Select.Trigger class="select-trigger" aria-label={t("settings.vectorProvider")}>
						<Select.Value<"none" | "remote" | "local">>
							{(state) => t(`settings.vectorProviders.${state.selectedOption()}`)}
						</Select.Value>
					</Select.Trigger>
				</Select>
				<Show when={vectorProvider() === "remote"}>
					<Select
						options={[...VECTOR_PRESETS]}
						optionTextValue={(preset) => preset.label}
						onChange={(preset) => {
							if (!preset) return;
							setRemoteModel(preset.value);
							setRemoteDimensions(preset.dimensions);
						}}
						placeholder={t("settings.vectorPreset")}
						aria-label={t("settings.vectorPreset")}
						itemComponent={(props) => (
							<Select.Item item={props.item} class="select-item">
								<Select.ItemLabel>{props.item.rawValue.label}</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Trigger class="select-trigger" aria-label={t("settings.vectorPreset")}>
							<Select.Value<Readonly<{ value: string; label: string; dimensions: number }>>>
								{(state) => state.selectedOption()?.label ?? ""}
							</Select.Value>
						</Select.Trigger>
					</Select>
					<TextField class="setting-field">
						<TextField.Label>{t("settings.customBaseUrl")}</TextField.Label>
						<TextField.Input
							type="text"
							placeholder="https://api.siliconflow.cn/v1"
							value={remoteBaseUrl()}
							onInput={(event) => setRemoteBaseUrl(event.currentTarget.value)}
						/>
					</TextField>
					<TextField class="setting-field">
						<TextField.Label>{t("settings.apiKeyLabel")}</TextField.Label>
						<TextField.Input
							type="password"
							autocomplete="off"
							value={remoteApiKey()}
							onInput={(event) => setRemoteApiKey(event.currentTarget.value)}
						/>
					</TextField>
					<TextField class="setting-field">
						<TextField.Label>{t("settings.vectorModel")}</TextField.Label>
						<TextField.Input
							type="text"
							placeholder="BAAI/bge-m3"
							value={remoteModel()}
							onInput={(event) => setRemoteModel(event.currentTarget.value)}
						/>
					</TextField>
					<TextField class="setting-field">
						<TextField.Label>{t("settings.vectorDimensions")}</TextField.Label>
						<TextField.Input
							type="number"
							value={remoteDimensions()}
							onInput={(event) =>
								setRemoteDimensions(Number(event.currentTarget.value) || 0)
							}
						/>
					</TextField>
				</Show>
				<Show when={vectorProvider() === "local"}>
					<p class="drawer-note">{t("settings.memoryVectorLocalNote")}</p>
				</Show>
			</Show>

			<h4>{t("settings.downloadMirrorSection")}</h4>
			<TextField class="setting-field">
				<TextField.Label>{t("settings.downloadMirrorLabel")}</TextField.Label>
				<TextField.Input
					type="text"
					placeholder="https://hf-mirror.com"
					value={mirrorEndpoint()}
					onInput={(event) => setMirrorEndpoint(event.currentTarget.value)}
				/>
			</TextField>

			<div class="setting-actions">
				<Button
					type="button"
					class="primary-tool"
					disabled={saving()}
					onClick={() => void save()}
				>
					{t("settings.saveNetwork")}
				</Button>
			</div>
		</section>
	);
}