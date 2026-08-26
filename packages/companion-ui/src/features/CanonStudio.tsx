import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Checkbox } from "@kobalte/core/checkbox";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { For, Show } from "solid-js";
import { createBackstageWorkflowStore } from "../stores/backstage-workflows.js";
import { useCompanionStore } from "../stores/companion.js";

export function CanonStudio() {
	const [t] = useTranslation(undefined, { i18n });
	const companion = useCompanionStore();
	const workflow = createBackstageWorkflowStore(companion);
	const state = workflow.canon(
		() => t("canonStudio.moduleNoParent"),
		(kind) => t(`canonStudio.kinds.${kind}`),
	);

	return (
		<div class="canon-studio">
			<p class="drawer-note">{t("canonStudio.note")}</p>
			<section>
				<h3>{t("canonStudio.sources")}</h3>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						state.addSource();
					}}
				>
					<TextField>
						<TextField.Input
							aria-label={t("canonStudio.sourceName")}
							placeholder={t("canonStudio.sourceName")}
							value={state.sourceName()}
							onInput={(event) => state.setSourceName(event.currentTarget.value)}
						/>
					</TextField>
					<TextField>
						<TextField.TextArea
							rows={7}
							aria-label={t("canonStudio.sourceText")}
							placeholder={t("canonStudio.sourceText")}
							value={state.sourceText()}
							onInput={(event) => state.setSourceText(event.currentTarget.value)}
						/>
					</TextField>
					<Button
						data-control="command"
						type="submit"
						disabled={state.busy() || !state.sourceName().trim() || !state.sourceText().trim()}
					>
						{t("canonStudio.addSource")}
					</Button>
				</form>
				<For each={state.sources()}>
					{(source) => (
						<div class="canon-row">
							<div>
								<strong>{source.logicalName}</strong>
								<span>
									{source.chunkCount} {t("canonStudio.chunks")}
								</span>
								<Show when={source.origin === "package"}>
									<span>{t("canonStudio.packageManaged")}</span>
								</Show>
								<Show when={source.language}>
									<span>
										{t("canonStudio.sourceLanguage", { language: source.language ?? "" })}
									</span>
								</Show>
							</div>
							<Show when={source.origin !== "package"}>
								<Button
									data-control="command"
									type="button"
									aria-label={`${t("canonStudio.remove")} ${source.logicalName}`}
									onClick={() => {
										if (window.confirm(t("canonStudio.removeConfirm")))
											state.removeSource(source.id);
									}}
								>
									{t("canonStudio.remove")}
								</Button>
							</Show>
						</div>
					)}
				</For>
			</section>
			<section>
				<h3>{t("canonStudio.search")}</h3>
				<form
					class="canon-search"
					onSubmit={(event) => {
						event.preventDefault();
						state.search();
					}}
				>
					<TextField>
						<TextField.Input
							aria-label={t("canonStudio.search")}
							value={state.query()}
							onInput={(event) => state.setQuery(event.currentTarget.value)}
						/>
					</TextField>
					<Button data-control="command" type="submit">
						{t("canonStudio.search")}
					</Button>
				</form>
				<For each={state.results()}>
					{(chunk) => (
						<Checkbox
							class="canon-result"
							checked={state.selectedChunks().includes(chunk.id)}
							onChange={(checked) => state.toggleChunk(chunk.id, checked)}
						>
							<Checkbox.Input />
							<Checkbox.Control>
								<Checkbox.Indicator>✓</Checkbox.Indicator>
							</Checkbox.Control>
							<Checkbox.Label>
								<span>
									<strong>
										{chunk.sourceName} · {chunk.ordinal + 1}
									</strong>
									{chunk.content}
								</span>
							</Checkbox.Label>
						</Checkbox>
					)}
				</For>
			</section>
			<section>
				<h3>{t("canonStudio.modules")}</h3>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						state.saveModule();
					}}
				>
					<Select
						options={state.moduleKinds()}
						value={state.moduleKinds().find((kind) => kind.id === state.moduleKind()) ?? null}
						optionValue="id"
						optionTextValue="label"
						onChange={(kind) => kind && state.setModuleKind(kind.id)}
						itemComponent={(itemProps) => (
							<Select.Item item={itemProps.item} class="select-item">
								<Select.ItemLabel>{itemProps.item.rawValue.label}</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Trigger class="select-trigger" aria-label={t("canonStudio.moduleKind")}>
							<Select.Value class="select-value" />
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
					</Select>
					<Select
						options={state.parentModules()}
						value={
							state.parentModules().find((module) => module.id === state.moduleParentId()) ?? null
						}
						optionValue="id"
						optionTextValue="title"
						onChange={(module) => state.setModuleParentId(module?.id ?? "")}
						itemComponent={(itemProps) => (
							<Select.Item item={itemProps.item} class="select-item">
								<Select.ItemLabel>{itemProps.item.rawValue.title}</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Trigger class="select-trigger" aria-label={t("canonStudio.moduleParent")}>
							<Select.Value class="select-value" />
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
					</Select>
					<TextField>
						<TextField.Input
							aria-label={t("canonStudio.moduleTitle")}
							placeholder={t("canonStudio.moduleTitle")}
							value={state.moduleTitle()}
							onInput={(event) => state.setModuleTitle(event.currentTarget.value)}
						/>
					</TextField>
					<TextField>
						<TextField.TextArea
							aria-label={t("canonStudio.moduleInstructions")}
							rows={4}
							placeholder={t("canonStudio.moduleInstructions")}
							value={state.moduleInstructions()}
							onInput={(event) => state.setModuleInstructions(event.currentTarget.value)}
						/>
					</TextField>
					<Button
						data-control="command"
						type="submit"
						disabled={state.busy() || !state.moduleTitle().trim()}
					>
						{state.editingModuleId() ? t("canonStudio.updateModule") : t("canonStudio.saveModule")}
					</Button>
					<Show when={state.editingModuleId()}>
						<Button data-control="command" type="button" onClick={state.clearModuleForm}>
							{t("canonStudio.cancelEdit")}
						</Button>
					</Show>
				</form>
				<Show when={state.modules().length === 0}>
					<p class="drawer-note">{t("canonStudio.noModules")}</p>
				</Show>
				<For each={state.modules()}>
					{(module) => (
						<div class="canon-row">
							<div>
								<strong>{module.title}</strong>
								<span>
									{t(`canonStudio.kinds.${module.kind}`)} · {module.sourceChunkIds.length}{" "}
									{t("canonStudio.references")}
								</span>
								<Show when={module.origin === "package"}>
									<span>{t("canonStudio.packageManaged")}</span>
								</Show>
							</div>
							<Show when={module.origin !== "package"}>
								<div class="canon-row-actions">
									<Button
										data-control="command"
										type="button"
										aria-label={`${t("canonStudio.editModule")} ${module.title}`}
										onClick={() => state.editModule(module)}
									>
										{t("canonStudio.editModule")}
									</Button>
									<Button
										data-control="command"
										type="button"
										aria-label={`${t("canonStudio.remove")} ${module.title}`}
										onClick={() => state.deleteModule(module.id)}
									>
										{t("canonStudio.remove")}
									</Button>
								</div>
							</Show>
						</div>
					)}
				</For>
			</section>
		</div>
	);
}
