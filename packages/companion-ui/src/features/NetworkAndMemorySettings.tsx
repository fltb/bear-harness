import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Checkbox } from "@kobalte/core/checkbox";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { Show } from "solid-js";
import { createNetworkMemoryWorkflow, PROXY_MODES, VECTOR_PRESETS, VECTOR_PROVIDERS } from "../stores/setup-workflows.js";
import { useCompanionStore } from "../stores/companion.js";

/**
 * Product network / memory-vector / download-mirror settings. These are
 * app-level settings persisted in the app_settings row; changing the vector
 * service or the mirror requires a restart, while the proxy applies live.
 */
export function NetworkAndMemorySettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = createNetworkMemoryWorkflow(store, t);
	const {
		proxyMode,
		proxyUrl,
		vectorEnabled,
		vectorProvider,
		remoteBaseUrl,
		remoteApiKey,
		remoteModel,
		remoteDimensions,
		localModel,
		localCustomPath,
		mirrorEndpoint,
		setProxyMode,
		setProxyUrl,
		setVectorEnabled,
		setVectorProvider,
		setRemoteBaseUrl,
		setRemoteApiKey,
		setRemoteModel,
		setRemoteDimensions,
		setLocalModel,
		setLocalCustomPath,
		setMirrorEndpoint,
		localModelOptions,
		localModelSelection,
		vectorPresets,
		saving,
		error,
		feedback,
		save,
	} = workflow;

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
				<Select.Portal>
					<Select.Content class="select-content">
						<Select.Listbox class="select-listbox" />
					</Select.Content>
				</Select.Portal>
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
				<Checkbox checked={vectorEnabled()} onChange={(checked) => setVectorEnabled(checked)}>
					<Checkbox.Input />
					<Checkbox.Control />
					<Checkbox.Label>{t("settings.memoryVectorEnabled")}</Checkbox.Label>
				</Checkbox>
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
					<Select.Portal>
						<Select.Content class="select-content">
							<Select.Listbox class="select-listbox" />
						</Select.Content>
					</Select.Portal>
				</Select>
				<Show when={vectorProvider() === "remote"}>
					<Select
						options={vectorPresets()}
						optionTextValue={(preset) => t(`settings.vectorPresetLabels.${preset.key}` as never)}
						onChange={(preset) => {
							if (!preset) return;
							setRemoteModel(preset.value);
							setRemoteDimensions(preset.dimensions);
						}}
						placeholder={t("settings.vectorPreset")}
						aria-label={t("settings.vectorPreset")}
						itemComponent={(props) => (
							<Select.Item item={props.item} class="select-item">
								<Select.ItemLabel>
									{t(
										`settings.vectorPresetLabels.${(props.item.rawValue as (typeof VECTOR_PRESETS)[number]).key}` as never,
									)}
								</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Trigger class="select-trigger" aria-label={t("settings.vectorPreset")}>
							<Select.Value<Readonly<{ value: string; key: string; dimensions: number }>>>
								{(state) =>
									state.selectedOption()
										? t(`settings.vectorPresetLabels.${state.selectedOption()!.key}` as never)
										: ""
								}
							</Select.Value>
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
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
							onInput={(event) => setRemoteDimensions(Number(event.currentTarget.value) || 0)}
						/>
					</TextField>
				</Show>
				<Show when={vectorProvider() === "local"}>
					<Select
						options={localModelOptions()}
						optionTextValue={(model) => t(`settings.localModels.${model.id}` as never)}
						onChange={(model) => model && setLocalModel(model.id)}
						value={localModelSelection()}
						placeholder={t("settings.localModel")}
						aria-label={t("settings.localModel")}
						itemComponent={(props) => (
							<Select.Item item={props.item} class="select-item">
								<Select.ItemLabel>
									{t(`settings.localModels.${(props.item.rawValue as { id: string }).id}` as never)}
								</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Trigger class="select-trigger" aria-label={t("settings.localModel")}>
							<Select.Value<{ id: string; source: string; dimensions: number }>>
								{(state) =>
									state.selectedOption()
										? t(`settings.localModels.${state.selectedOption()!.id}` as never)
										: ""
								}
							</Select.Value>
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
					</Select>
					<Show when={localModel() === "custom"}>
						<TextField class="setting-field">
							<TextField.Label>{t("settings.localCustomPath")}</TextField.Label>
							<TextField.Input
								type="text"
								placeholder={t("settings.localCustomPathPlaceholder")}
								value={localCustomPath()}
								onInput={(event) => setLocalCustomPath(event.currentTarget.value)}
							/>
						</TextField>
					</Show>
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
				<Button type="button" class="primary-tool" disabled={saving()} onClick={() => void save()}>
					{t("settings.saveNetwork")}
				</Button>
			</div>
		</section>
	);
}
