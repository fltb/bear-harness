import { createEffect, createSignal, For, Show } from "solid-js";
import { t } from "../i18n.js";
import { useCompanionStore } from "../stores/companion.js";
import type { CanonChunk, CanonModuleKind } from "../stores/ipc.js";

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
					<input
						aria-label={t("canonStudio.sourceName")}
						placeholder={t("canonStudio.sourceName")}
						value={sourceName()}
						onInput={(event) => setSourceName(event.currentTarget.value)}
					/>
					<textarea
						rows={7}
						aria-label={t("canonStudio.sourceText")}
						placeholder={t("canonStudio.sourceText")}
						value={sourceText()}
						onInput={(event) => setSourceText(event.currentTarget.value)}
					/>
					<button
						data-control="command"
						type="submit"
						disabled={busy() || !sourceName().trim() || !sourceText().trim()}
					>
						{t("canonStudio.addSource")}
					</button>
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
							<button
								data-control="command"
								type="button"
								aria-label={`${t("canonStudio.remove")} ${source.logicalName}`}
								onClick={() => {
									if (window.confirm(t("canonStudio.removeConfirm")))
										void store.canon.removeSource(source.id);
								}}
							>
								{t("canonStudio.remove")}
							</button>
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
					<input
						aria-label={t("canonStudio.search")}
						value={query()}
						onInput={(event) => setQuery(event.currentTarget.value)}
					/>
					<button data-control="command" type="submit">
						{t("canonStudio.search")}
					</button>
				</form>
				<For each={results()}>
					{(chunk) => (
						<label class="canon-result">
							<input
								type="checkbox"
								checked={selectedChunks().includes(chunk.id)}
								onChange={(event) =>
									setSelectedChunks((current) =>
										event.currentTarget.checked
											? [...current, chunk.id]
											: current.filter((id) => id !== chunk.id),
									)
								}
							/>
							<span>
								<strong>
									{chunk.sourceName} · {chunk.ordinal + 1}
								</strong>
								{chunk.content}
							</span>
						</label>
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
					<select
						aria-label={t("canonStudio.moduleKind")}
						value={moduleKind()}
						onChange={(event) => setModuleKind(event.currentTarget.value as CanonModuleKind)}
					>
						<option value="root">{t("canonStudio.kinds.root")}</option>
						<option value="arc">{t("canonStudio.kinds.arc")}</option>
						<option value="event">{t("canonStudio.kinds.event")}</option>
						<option value="entity">{t("canonStudio.kinds.entity")}</option>
						<option value="relationship">{t("canonStudio.kinds.relationship")}</option>
						<option value="location">{t("canonStudio.kinds.location")}</option>
						<option value="object">{t("canonStudio.kinds.object")}</option>
						<option value="behavior">{t("canonStudio.kinds.behavior")}</option>
					</select>
					<select
						aria-label={t("canonStudio.moduleParent")}
						value={moduleParentId()}
						onChange={(event) => setModuleParentId(event.currentTarget.value)}
					>
						<option value="">{t("canonStudio.moduleNoParent")}</option>
						<For each={store.canon.modules().filter((module) => module.id !== editingModuleId())}>
							{(module) => <option value={module.id}>{module.title}</option>}
						</For>
					</select>
					<input
						aria-label={t("canonStudio.moduleTitle")}
						placeholder={t("canonStudio.moduleTitle")}
						value={moduleTitle()}
						onInput={(event) => setModuleTitle(event.currentTarget.value)}
					/>
					<textarea
						aria-label={t("canonStudio.moduleInstructions")}
						rows={4}
						placeholder={t("canonStudio.moduleInstructions")}
						value={moduleInstructions()}
						onInput={(event) => setModuleInstructions(event.currentTarget.value)}
					/>
					<button data-control="command" type="submit" disabled={busy() || !moduleTitle().trim()}>
						{editingModuleId() ? t("canonStudio.updateModule") : t("canonStudio.saveModule")}
					</button>
					<Show when={editingModuleId()}>
						<button data-control="command" type="button" onClick={clearModuleForm}>
							{t("canonStudio.cancelEdit")}
						</button>
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
								<button
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
								</button>
								<button
									data-control="command"
									type="button"
									aria-label={`${t("canonStudio.remove")} ${module.title}`}
									onClick={() => void store.canon.deleteModule(module.id)}
								>
									{t("canonStudio.remove")}
								</button>
							</div>
						</div>
					)}
				</For>
			</section>
		</div>
	);
}
