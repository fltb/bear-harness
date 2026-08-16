import { Button } from "@kobalte/core/button";
import { Checkbox } from "@kobalte/core/checkbox";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createSignal, For, Show } from "solid-js";
import { t } from "../i18n.js";
import { useCompanionStore } from "../stores/companion.js";
import type { CanonChunk, CanonModule, CanonModuleKind } from "../stores/ipc.js";

export function CanonStudio() {
	const store = useCompanionStore();
	const [sourceName, setSourceName] = createSignal("");
	const [sourceText, setSourceText] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [results, setResults] = createSignal<CanonChunk[]>([]);
	const [moduleTitle, setModuleTitle] = createSignal("");
	const [moduleInstructions, setModuleInstructions] = createSignal("");
	const [moduleKind, setModuleKind] = createSignal<CanonModuleKind>("arc");
	const [moduleParentId, setModuleParentId] = createSignal("");
	const [editingModuleId, setEditingModuleId] = createSignal<string | undefined>();
	const [selectedChunks, setSelectedChunks] = createSignal<string[]>([]);
	const [busy, setBusy] = createSignal(false);
	const moduleKinds = (): Array<{ id: CanonModuleKind; label: string }> =>
		(
			["root", "arc", "event", "entity", "relationship", "location", "object", "behavior"] as const
		).map((id) => ({ id, label: t(`canonStudio.kinds.${id}`) }));
	const parentModules = (): CanonModule[] => [
		{
			id: "",
			kind: "root",
			title: t("canonStudio.moduleNoParent"),
			instructions: "",
			sourceChunkIds: [],
			createdAt: "",
		},
		...store.canon.modules().filter((module) => module.id !== editingModuleId()),
	];
	const clearModuleForm = () => {
		setModuleTitle("");
		setModuleInstructions("");
		setModuleKind("arc");
		setModuleParentId("");
		setEditingModuleId(undefined);
		setSelectedChunks([]);
	};

	createEffect(() => {
		void Promise.all([store.canon.listSources(), store.canon.listModules()]);
	});

	return (
		<div class="canon-studio">
			<p class="drawer-note">{t("canonStudio.note")}</p>
			<section>
				<h3>{t("canonStudio.sources")}</h3>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (!sourceName().trim() || !sourceText().trim()) return;
						setBusy(true);
						void store.canon
							.addSource(sourceName().trim(), sourceText())
							.then(() => {
								setSourceName("");
								setSourceText("");
							})
							.finally(() => setBusy(false));
					}}
				>
					<TextField>
						<TextField.Input
							aria-label={t("canonStudio.sourceName")}
							placeholder={t("canonStudio.sourceName")}
							value={sourceName()}
							onInput={(event) => setSourceName(event.currentTarget.value)}
						/>
					</TextField>
					<TextField>
						<TextField.TextArea
							rows={7}
							aria-label={t("canonStudio.sourceText")}
							placeholder={t("canonStudio.sourceText")}
							value={sourceText()}
							onInput={(event) => setSourceText(event.currentTarget.value)}
						/>
					</TextField>
					<Button
						data-control="command"
						type="submit"
						disabled={busy() || !sourceName().trim() || !sourceText().trim()}
					>
						{t("canonStudio.addSource")}
					</Button>
				</form>
				<For each={store.canon.sources()}>
					{(source) => (
						<div class="canon-row">
							<div>
								<strong>{source.logicalName}</strong>
								<span>
									{source.chunkCount} {t("canonStudio.chunks")}
								</span>
							</div>
							<Button
								data-control="command"
								type="button"
								aria-label={`${t("canonStudio.remove")} ${source.logicalName}`}
								onClick={() => {
									if (window.confirm(t("canonStudio.removeConfirm")))
										void store.canon.removeSource(source.id);
								}}
							>
								{t("canonStudio.remove")}
							</Button>
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
						if (query().trim()) void store.canon.search(query()).then(setResults);
					}}
				>
					<TextField>
						<TextField.Input
							aria-label={t("canonStudio.search")}
							value={query()}
							onInput={(event) => setQuery(event.currentTarget.value)}
						/>
					</TextField>
					<Button data-control="command" type="submit">
						{t("canonStudio.search")}
					</Button>
				</form>
				<For each={results()}>
					{(chunk) => (
						<Checkbox
							class="canon-result"
							checked={selectedChunks().includes(chunk.id)}
							onChange={(checked) =>
								setSelectedChunks((current) =>
									checked ? [...current, chunk.id] : current.filter((id) => id !== chunk.id),
								)
							}
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
						if (!moduleTitle().trim()) return;
						setBusy(true);
						void store.canon
							.upsertModule({
								...(editingModuleId() ? { id: editingModuleId() } : {}),
								...(moduleParentId() ? { parentId: moduleParentId() } : {}),
								kind: moduleKind(),
								title: moduleTitle().trim(),
								instructions: moduleInstructions().trim(),
								sourceChunkIds: selectedChunks(),
							})
							.then(clearModuleForm)
							.finally(() => setBusy(false));
					}}
				>
					<Select
						options={moduleKinds()}
						value={moduleKinds().find((kind) => kind.id === moduleKind()) ?? null}
						optionValue="id"
						optionTextValue="label"
						onChange={(kind) => kind && setModuleKind(kind.id)}
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
						options={parentModules()}
						value={parentModules().find((module) => module.id === moduleParentId()) ?? null}
						optionValue="id"
						optionTextValue="title"
						onChange={(module) => setModuleParentId(module?.id ?? "")}
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
							value={moduleTitle()}
							onInput={(event) => setModuleTitle(event.currentTarget.value)}
						/>
					</TextField>
					<TextField>
						<TextField.TextArea
							aria-label={t("canonStudio.moduleInstructions")}
							rows={4}
							placeholder={t("canonStudio.moduleInstructions")}
							value={moduleInstructions()}
							onInput={(event) => setModuleInstructions(event.currentTarget.value)}
						/>
					</TextField>
					<Button data-control="command" type="submit" disabled={busy() || !moduleTitle().trim()}>
						{editingModuleId() ? t("canonStudio.updateModule") : t("canonStudio.saveModule")}
					</Button>
					<Show when={editingModuleId()}>
						<Button data-control="command" type="button" onClick={clearModuleForm}>
							{t("canonStudio.cancelEdit")}
						</Button>
					</Show>
				</form>
				<Show when={store.canon.modules().length === 0}>
					<p class="drawer-note">{t("canonStudio.noModules")}</p>
				</Show>
				<For each={store.canon.modules()}>
					{(module) => (
						<div class="canon-row">
							<div>
								<strong>{module.title}</strong>
								<span>
									{t(`canonStudio.kinds.${module.kind}`)} · {module.sourceChunkIds.length}{" "}
									{t("canonStudio.references")}
								</span>
							</div>
							<div class="canon-row-actions">
								<Button
									data-control="command"
									type="button"
									aria-label={`${t("canonStudio.editModule")} ${module.title}`}
									onClick={() => {
										setEditingModuleId(module.id);
										setModuleParentId(module.parentId ?? "");
										setModuleKind(module.kind);
										setModuleTitle(module.title);
										setModuleInstructions(module.instructions);
										setSelectedChunks(module.sourceChunkIds);
									}}
								>
									{t("canonStudio.editModule")}
								</Button>
								<Button
									data-control="command"
									type="button"
									aria-label={`${t("canonStudio.remove")} ${module.title}`}
									onClick={() => void store.canon.deleteModule(module.id)}
								>
									{t("canonStudio.remove")}
								</Button>
							</div>
						</div>
					)}
				</For>
			</section>
		</div>
	);
}
