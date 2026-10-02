import { i18n, useTranslation } from "@bear-harness/i18n";
import type { CharacterDraftReviewResponse } from "@bear-harness/protocol";
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { isNode, parseDocument } from "yaml";
import { downloadBlob } from "../../lib/browser-download.js";
import { useCompanionStore } from "../../stores/companion.js";
import { Button, Checkbox, Dialog, FileField, TextField } from "../../ui/primitives.js";
import { DraftPreview } from "./DraftPreview.js";
import { ManifestFields } from "./ManifestFields.js";
import { formSections, PackageForms, SkillFields } from "./PackageForms.js";
import type { EditorSchema } from "./SchemaFields.js";
import { StudioReview } from "./StudioReview.js";
import { StudioTrial } from "./StudioTrial.js";
import { createStudioWorkflow } from "./workflow.js";

export function CharacterStudio(props: {
	onClose(): void;
	onOpenSettings?(): void;
	initialCharacterId?: string;
}) {
	let editor: HTMLElement | undefined;
	let sourceEditor: HTMLTextAreaElement | undefined;
	let focusingIssue = false;
	let uploadController: AbortController | undefined;
	const [uploadProgress, setUploadProgress] = createSignal<{
		name: string;
		bytes: number;
		total: number;
	}>();
	onCleanup(() => uploadController?.abort());
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const api = store.characters;
	const workflow = createStudioWorkflow(api);
	const [schemas] = createResource(() => api.authoringSchema());
	const schemaData = () => (schemas.error ? undefined : schemas());
	const [trialOpen, setTrialOpen] = createSignal(false);
	const [section, setSection] = createSignal("");
	const [preview, setPreview] = createSignal<{ file?: string }>();
	const [migrationAccepted, setMigrationAccepted] = createSignal(false);
	const [reviewData, setReviewData] = createSignal<CharacterDraftReviewResponse>();
	const [skillForm, setSkillForm] = createSignal(false);
	const [fileSearch, setFileSearch] = createSignal("");
	const [moreDrafts, setMoreDrafts] = createSignal<Awaited<ReturnType<typeof api.draftList>>>([]);
	const [draftCursor, setDraftCursor] = createSignal<string>();
	const [directoryOpen, setDirectoryOpen] = createSignal(false);
	function showEditor() {
		setDirectoryOpen(false);
		requestAnimationFrame(() => {
			if (editor?.isConnected) editor.scrollTop = 0;
		});
	}

	const [library, { refetch }] = createResource(async () => {
		const [characters, page] = await Promise.all([api.list(), api.draftListPage()]);
		setMoreDrafts([]);
		setDraftCursor(page.nextCursor);
		return { characters: characters.characters, drafts: page.drafts };
	});
	const libraryData = () => (library.error ? undefined : library());
	const [search, setSearch] = createSignal("");
	const [name, setName] = createSignal("");
	const [id, setId] = createSignal("");
	const [copy, setCopy] = createSignal<string>();
	const [creating, setCreating] = createSignal(false);
	const [fields, setFields] = createSignal(true);
	const [path, setPath] = createSignal("");
	const [review, setReview] = createSignal(false);
	const [history, setHistory] = createSignal<Array<{ revision: number; createdAt: string }>>([]);
	const fileOrder = (path: string) =>
		path === "character.yaml"
			? 0
			: path === "STORY.md"
				? 1
				: path.startsWith("canon/")
					? 2
					: path.startsWith("skills/")
						? 3
						: path.startsWith("assets/")
							? 5
							: 4;
	const files = createMemo(() =>
		Object.keys(workflow.draft()?.files ?? {}).sort(
			(a, b) => fileOrder(a) - fileOrder(b) || a.localeCompare(b),
		),
	);
	const displayed = createMemo(
		() =>
			libraryData()?.characters.filter((character) =>
				`${character.name} ${character.id}`.toLowerCase().includes(search().toLowerCase()),
			) ?? [],
	);
	const text = () => workflow.texts()[workflow.selected()] ?? "";
	const messages: Record<string, string> = {
		character_package_already_exists: t("studio.idExists"),
		character_package_busy: t("studio.busyRole"),
		character_package_revision_mismatch: t("studio.packageConflict"),
		character_draft_revision_mismatch: t("studio.draftConflict"),
		character_id_immutable: t("studio.immutableId"),
		character_state_schema_change_requires_migration: t("studio.stateConflict"),
		character_display_removal_requires_migration: t("studio.displayConflict"),
		character_draft_file_size_limit: t("studio.fileLimit"),
		character_package_path_invalid: t("studio.pathInvalid"),
	};
	const errorText = () => messages[workflow.error()] ?? workflow.error();
	async function edit(characterId: string) {
		const existing = (await api.draftList(characterId)).find(
			(item) => item.characterId === characterId,
		);
		await workflow.open(
			existing ? await api.draftGet(existing.id) : await api.draftCreate({ characterId }),
		);
		setFields(true);
		setSection("");
		showEditor();
	}
	async function leave() {
		await workflow.flush();
		workflow.clear();
		await refetch();
	}
	async function create() {
		const next = await api.draftCreate({
			characterId: id().trim(),
			name: name().trim(),
			...(copy() ? { basePackageId: copy() } : {}),
			locale: i18n.language,
		});
		await workflow.open(next);
		setCreating(false);
		setFields(true);
		setSection("");
		showEditor();
		await refetch();
	}
	const run = (work: () => Promise<void>) => void workflow.action(work);
	onMount(() => {
		if (props.initialCharacterId) run(() => edit(props.initialCharacterId as string));
	});
	async function addFile() {
		const name = path().trim();
		if (!name) return;
		if (workflow.draft()?.files[name]) throw new Error(t("studio.fileExists"));
		await workflow.patch({
			[name]: {
				encoding: "utf8",
				content: name.endsWith("/SKILL.md")
					? "---\nname: new-skill\ndescription: ''\ntriggers:\n  include: []\n  exclude: []\nallowed-tools: [host_choices]\npriority: 0\n---\n"
					: "",
			},
		});
		setPath("");
		setFields(false);
		showEditor();
		await workflow.select(name);
	}
	async function upload(files: File[], folder = "assets") {
		await workflow.flush();
		uploadController = new AbortController();
		const controller = uploadController;
		try {
			for (const file of files) {
				if (controller.signal.aborted) break;
				const current = workflow.draft();
				if (!current) return;
				let target = `${folder}/${file.name}`;
				if (folder === "canon") {
					let suffix = 2;
					const dot = file.name.lastIndexOf(".");
					const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
					const ext = dot > 0 ? file.name.slice(dot) : "";
					while (current.files[target]) target = `${folder}/${stem}-${suffix++}${ext}`;
				}
				if (current.files[target] && !window.confirm(t("studio.replaceFile", { path: target })))
					continue;
				const next = await api.draftUploadFile(current.id, current.currentRevision, target, file, {
					signal: controller.signal,
					onProgress: (bytes) => setUploadProgress({ name: file.name, bytes, total: file.size }),
				});
				await workflow.open(next);
				setFields(false);
				showEditor();
				await workflow.select(target);
			}
		} catch (error) {
			if (!controller.signal.aborted) throw error;
		} finally {
			uploadController = undefined;
			setUploadProgress(undefined);
		}
	}
	async function showPreview(file?: string) {
		await workflow.flush();
		const current = workflow.draft();
		if (!file && current) await api.draftValidate(current.id, current.currentRevision);
		setPreview(file ? { file } : {});
	}
	async function exportPackage() {
		await workflow.flush();
		const current = workflow.draft();
		if (!current) return;
		const bytes = await api.draftExport(current.id, current.currentRevision);
		downloadBlob(
			new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
			`${current.characterId}.zip`,
		);
	}
	async function moveFile() {
		await workflow.flush();
		const current = workflow.draft();
		if (!current) return;
		const to = window.prompt(t("studio.movePath"), workflow.selected());
		if (!to || to === workflow.selected()) return;
		const result = await api.draftManage({
			action: "move",
			id: current.id,
			expectedRevision: current.currentRevision,
			from: workflow.selected(),
			to,
		});
		if (result.draft) {
			await workflow.open(result.draft);
			setFields(false);
			await workflow.select(to);
		}
	}

	async function download() {
		await workflow.flush();
		const current = workflow.draft();
		if (!current) return;
		const bytes = await api.draftFile(current.id, workflow.selected());
		downloadBlob(new Blob([new Uint8Array(bytes)]), workflow.selected());
	}
	return (
		<section class="character-studio" aria-label={t("studio.library")}>
			<header class="studio-header">
				<Button
					disabled={workflow.busy()}
					onClick={() =>
						run(async () => {
							if (workflow.draft()) await leave();
							else props.onClose();
						})
					}
				>
					{workflow.draft() ? t("studio.backLibrary") : t("studio.backChat")}
				</Button>
				<div class="studio-heading">
					<h1>{workflow.draft() ? t("studio.editRole") : t("studio.library")}</h1>
					<Show when={workflow.draft()}>
						<span>{workflow.draft()?.characterId}</span>
					</Show>
				</div>
				<Show when={workflow.draft()}>
					<Button disabled={workflow.busy()} onClick={() => run(() => showPreview())}>
						{t("studio.preview")}
					</Button>
					<Button
						disabled={workflow.busy()}
						onClick={() =>
							run(async () => {
								await workflow.flush();
								setTrialOpen(true);
							})
						}
					>
						{t("studio.trial")}
					</Button>
					<Button disabled={workflow.busy()} onClick={() => run(exportPackage)}>
						{t("studio.exportZip")}
					</Button>
					<Button
						disabled={workflow.busy()}
						class="studio-directory-toggle"
						onClick={() => setDirectoryOpen(!directoryOpen())}
					>
						{t("studio.contents")}
					</Button>
					<Button
						disabled={workflow.busy() || !workflow.canUndo()}
						onClick={() => run(() => workflow.undo())}
					>
						{t("studio.undo")}
					</Button>
					<Button
						disabled={workflow.busy() || !workflow.canRedo()}
						onClick={() => run(() => workflow.undo(true))}
					>
						{t("studio.redo")}
					</Button>
					<span class="studio-save-state" role="status">
						{workflow.saving()
							? t("studio.saving")
							: workflow.dirty()
								? t("studio.unsaved")
								: t("studio.saved")}
					</span>
					<Button
						disabled={workflow.busy() || workflow.saving()}
						onClick={() => run(() => workflow.flush())}
					>
						{t("studio.save")}
					</Button>
					<Button
						data-variant="primary"
						disabled={workflow.busy() || workflow.saving()}
						onClick={() =>
							run(async () => {
								await workflow.flush();
								const draft = workflow.draft();
								if (!draft) return;
								setMigrationAccepted(false);
								setReviewData(await api.draftReview(draft.id, draft.currentRevision));
								setReview(true);
							})
						}
					>
						{t("studio.apply")}
					</Button>
				</Show>
			</header>
			<Show when={workflow.error() || library.error || schemas.error}>
				<div class="studio-error" role="alert">
					<p>{errorText() || String(library.error || schemas.error)}</p>
					<Button
						disabled={workflow.busy()}
						onClick={() =>
							run(async () => {
								if (workflow.draft()) {
									await workflow.flush();
									if (!workflow.loaded()) await workflow.select(workflow.selected());
								} else await refetch();
							})
						}
					>
						{t("studio.retry")}
					</Button>
					<Show when={workflow.error() === "character_package_revision_mismatch"}>
						<Button
							disabled={workflow.busy()}
							onClick={() =>
								run(async () => {
									await workflow.flush();
									const current = workflow.draft();
									if (!current) return;
									await workflow.open(await api.draftCreate({ characterId: current.characterId }));
									setFields(true);
									setSection("");
									showEditor();
								})
							}
						>
							{t("studio.freshDraft")}
						</Button>
					</Show>
					<Show when={workflow.dirty()}>
						<Button
							disabled={workflow.busy()}
							onClick={() =>
								downloadBlob(
									new Blob([text()], { type: "text/plain;charset=utf-8" }),
									workflow.selected(),
								)
							}
						>
							{t("studio.rescueText")}
						</Button>
						<Button
							disabled={workflow.busy()}
							onClick={() => {
								if (window.confirm(t("studio.discardQuestion"))) {
									workflow.clear();
									void refetch();
								}
							}}
						>
							{t("studio.discardUnsaved")}
						</Button>
					</Show>
				</div>
			</Show>
			<Show when={workflow.applied()}>
				<p class="studio-feedback" role="status">
					{t("studio.applied")}
				</p>
			</Show>
			<Show
				when={workflow.draft()}
				fallback={
					<div class="studio-library">
						<p>{t("studio.libraryHint")}</p>
						<div class="studio-tools">
							<TextField value={search()}>
								<TextField.Label>{t("studio.search")}</TextField.Label>
								<TextField.Input onInput={(event) => setSearch(event.currentTarget.value)} />
							</TextField>
							<Button
								disabled={workflow.busy()}
								data-variant="primary"
								onClick={() => {
									setCopy(undefined);
									setId("");
									setName("");
									setCreating(true);
								}}
							>
								{t("studio.newRole")}
							</Button>
							<FileField
								accept=".zip"
								maxFiles={1}
								disabled={workflow.busy()}
								onFileAccept={(files) =>
									run(async () => {
										const file = files[0];
										if (file) {
											await api.import(file);
											await refetch();
										}
									})
								}
							>
								<FileField.Trigger class="button-like">
									{t("backstage.roleImport")}
								</FileField.Trigger>
								<FileField.HiddenInput aria-label={t("backstage.roleImportInput")} />
							</FileField>
						</div>
						<Show when={library.loading}>
							<p role="status">{t("studio.loading")}</p>
						</Show>
						<div class="studio-cards">
							<For each={displayed()}>
								{(character) => (
									<article class="studio-card">
										<h2>{character.name}</h2>
										<p>{character.subtitle}</p>
										<code>{character.id}</code>
										<div class="studio-tools">
											<Button
												disabled={workflow.busy()}
												data-variant="primary"
												onClick={() => run(() => edit(character.id))}
											>
												{libraryData()?.drafts.some((draft) => draft.characterId === character.id)
													? t("studio.resume")
													: t("studio.edit")}
											</Button>
											<Button
												disabled={workflow.busy()}
												onClick={() => {
													setCopy(character.id);
													setId("");
													setName(character.name);
													setCreating(true);
												}}
											>
												{t("studio.copy")}
											</Button>
											<Button
												disabled={workflow.busy()}
												onClick={() =>
													run(async () => {
														await api.activate(character.id);
														props.onClose();
													})
												}
											>
												{t("studio.chat")}
											</Button>
										</div>
									</article>
								)}
							</For>
						</div>
						<Show when={libraryData()?.drafts.length}>
							<section>
								<h2>{t("studio.drafts")}</h2>
								<For each={[...(libraryData()?.drafts ?? []), ...moreDrafts()]}>
									{(draft) => (
										<div class="studio-draft-row">
											<span>
												{draft.characterId} · {draft.updatedAt}
											</span>
											<Button
												disabled={workflow.busy()}
												onClick={() =>
													run(async () => {
														await workflow.open(await api.draftGet(draft.id));
														setFields(true);
														setSection("");
														showEditor();
													})
												}
											>
												{t("studio.resume")}
											</Button>
											<Button
												disabled={workflow.busy()}
												onClick={() =>
													run(async () => {
														if (window.confirm(t("studio.deleteDraftConfirm"))) {
															await api.draftManage({
																action: "delete",
																id: draft.id,
																expectedRevision: draft.currentRevision,
															});
															await refetch();
														}
													})
												}
											>
												{t("studio.deleteDraft")}
											</Button>
										</div>
									)}
								</For>
								<Show when={draftCursor()}>
									<Button
										disabled={workflow.busy()}
										onClick={() =>
											run(async () => {
												const page = await api.draftListPage(draftCursor());
												setMoreDrafts([...moreDrafts(), ...page.drafts]);
												setDraftCursor(page.nextCursor);
											})
										}
									>
										{t("studio.loadMore")}
									</Button>
								</Show>
							</section>
						</Show>
					</div>
				}
			>
				<div class="studio-workspace" data-directory-open={directoryOpen()}>
					<nav class="studio-navigation" aria-label={t("studio.contents")}>
						<Button
							disabled={workflow.busy()}
							aria-current={fields() && !section() ? "page" : undefined}
							onClick={() =>
								run(async () => {
									await workflow.select("character.yaml");
									setFields(true);
									setSection("");
									showEditor();
								})
							}
						>
							{t("studio.commonFields")}
						</Button>
						<For each={formSections}>
							{(item) => (
								<Button
									disabled={workflow.busy()}
									aria-current={fields() && section() === item ? "page" : undefined}
									onClick={() =>
										run(async () => {
											await workflow.select("character.yaml");
											setFields(true);
											setSection(item);
											showEditor();
										})
									}
								>
									{t(`studio.sections.${item.replaceAll(".", "_")}` as "studio.sections.scenes")} ·{" "}
									{item}
								</Button>
							)}
						</For>
						<TextField class="studio-field" value={fileSearch()}>
							<TextField.Label>{t("studio.searchFiles")}</TextField.Label>
							<TextField.Input onInput={(event) => setFileSearch(event.currentTarget.value)} />
						</TextField>
						<p class="field-hint">{t("studio.fileHint")}</p>
						<For
							each={files().filter((file) =>
								file.toLowerCase().includes(fileSearch().toLowerCase()),
							)}
						>
							{(file) => (
								<Button
									disabled={workflow.busy()}
									class="studio-file"
									aria-current={!fields() && workflow.selected() === file ? "page" : undefined}
									onClick={() =>
										run(async () => {
											setFields(false);
											showEditor();
											await workflow.select(file);
										})
									}
								>
									{file}
								</Button>
							)}
						</For>
					</nav>
					<main class="studio-editor" ref={editor}>
						<Show when={workflow.loaded()} fallback={<p role="status">{t("studio.loading")}</p>}>
							<Show
								when={fields()}
								fallback={
									<>
										<div class="studio-tools">
											<h2>{workflow.selected()}</h2>
											<Button disabled={workflow.busy()} onClick={() => run(download)}>
												{t("studio.downloadFile")}
											</Button>
											<Button
												disabled={workflow.busy()}
												onClick={() => run(() => showPreview(workflow.selected()))}
											>
												{t("studio.previewFile")}
											</Button>
											<Show when={workflow.selected() !== "character.yaml"}>
												<Button disabled={workflow.busy()} onClick={() => run(moveFile)}>
													{t("studio.moveFile")}
												</Button>
											</Show>
											<Show when={workflow.selected().endsWith("/SKILL.md")}>
												<Button
													disabled={workflow.busy()}
													onClick={() => setSkillForm(!skillForm())}
												>
													{t(skillForm() ? "studio.source" : "studio.skillForm")}
												</Button>
											</Show>
											<Show when={workflow.selected() !== "character.yaml"}>
												<Button
													disabled={workflow.busy()}
													onClick={() =>
														run(async () => {
															const target = workflow.selected();
															if (window.confirm(t("studio.deleteFile", { path: target }))) {
																await workflow.patch({ [target]: null });
																await workflow.select("character.yaml");
															}
														})
													}
												>
													{t("studio.remove")}
												</Button>
											</Show>
										</div>
										<Show
											when={workflow.draft()?.files[workflow.selected()]?.encoding === "utf8"}
											fallback={
												<p>
													{t("studio.binaryHint", {
														bytes: workflow.draft()?.files[workflow.selected()]?.size ?? 0,
													})}
												</p>
											}
										>
											<Show
												when={
													skillForm() && workflow.selected().endsWith("/SKILL.md") && schemaData()
												}
												fallback={
													<TextField
														class="studio-source"
														value={text()}
														disabled={workflow.busy()}
													>
														<TextField.Label>{t("studio.source")}</TextField.Label>
														<TextField.TextArea
															ref={sourceEditor}
															spellcheck={false}
															rows={24}
															onInput={(event) =>
																workflow.edit(workflow.selected(), event.currentTarget.value)
															}
														/>
													</TextField>
												}
											>
												<SkillFields
													source={text()}
													schema={(schemaData()?.skill as EditorSchema) ?? {}}
													disabled={workflow.busy()}
													onChange={(value) => workflow.edit(workflow.selected(), value)}
												/>
											</Show>
										</Show>
									</>
								}
							>
								<p class="field-hint">{t("studio.fieldsHint")}</p>
								<Show
									when={!section()}
									fallback={
										<Show when={schemaData()}>
											<PackageForms
												source={workflow.texts()["character.yaml"] ?? ""}
												schema={(schemaData()?.manifest as EditorSchema) ?? {}}
												section={section()}
												assets={files().filter((path) => path.startsWith("assets/"))}
												disabled={workflow.busy()}
												onChange={(value) => workflow.edit("character.yaml", value)}
											/>
										</Show>
									}
								>
									<ManifestFields
										source={workflow.texts()["character.yaml"] ?? ""}
										disabled={workflow.busy()}
										onChange={(value) => workflow.edit("character.yaml", value)}
									/>
								</Show>
							</Show>
						</Show>
						<section class="studio-file-actions">
							<h2>{t("studio.addContent")}</h2>
							<p class="field-hint">{t("studio.pathHint")}</p>
							<form
								class="studio-tools"
								onSubmit={(event) => {
									event.preventDefault();
									run(addFile);
								}}
							>
								<TextField value={path()}>
									<TextField.Label>{t("studio.filePath")}</TextField.Label>
									<TextField.Input
										placeholder="canon/reference.md"
										onInput={(event) => setPath(event.currentTarget.value)}
									/>
								</TextField>
								<Button type="submit" disabled={!path().trim() || workflow.busy()}>
									{t("studio.newFile")}
								</Button>
							</form>
							<FileField
								maxFiles={20}
								disabled={workflow.busy()}
								onFileAccept={(files) => run(() => upload(files))}
							>
								<FileField.Trigger class="button-like">{t("studio.upload")}</FileField.Trigger>
								<FileField.HiddenInput aria-label={t("studio.upload")} />
							</FileField>
							<FileField
								maxFiles={20}
								accept=".md,.txt"
								disabled={workflow.busy()}
								onFileAccept={(files) => run(() => upload(files, "canon"))}
							>
								<FileField.Trigger class="button-like">{t("studio.importCanon")}</FileField.Trigger>
								<FileField.HiddenInput aria-label={t("studio.importCanon")} />
							</FileField>
							<Show when={uploadProgress()}>
								{(progress) => (
									<div class="studio-tools">
										<p role="status">
											{t("studio.uploadProgress", {
												name: progress().name,
												percent: Math.round(
													progress().total ? (progress().bytes / progress().total) * 100 : 100,
												),
											})}
										</p>
										<Button onClick={() => uploadController?.abort()}>
											{t("studio.cancelUpload")}
										</Button>
									</div>
								)}
							</Show>
							<p class="field-hint">{t("studio.fileLimit")}</p>
						</section>
						<details
							onToggle={(event) => {
								if (event.currentTarget.open)
									run(async () => {
										const draft = workflow.draft();
										if (draft) setHistory(await api.draftListRevisions(draft.id));
									});
							}}
						>
							<summary>{t("studio.history")}</summary>
							<Button
								disabled={workflow.busy()}
								onClick={() =>
									run(async () => {
										await workflow.flush();
										const current = workflow.draft();
										if (current && window.confirm(t("studio.pruneConfirm"))) {
											await api.draftManage({
												action: "prune",
												id: current.id,
												expectedRevision: current.currentRevision,
												keep: 20,
											});
											const remaining = await api.draftListRevisions(current.id);
											setHistory(remaining);
											workflow.retainHistory(remaining.map((item) => item.revision));
										}
									})
								}
							>
								{t("studio.prune")}
							</Button>
							<For each={history()}>
								{(revision) => (
									<fieldset class="studio-draft-row" aria-label={`#${revision.revision}`}>
										<span>
											#{revision.revision} · {revision.createdAt}
										</span>
										<Button
											disabled={
												revision.revision === workflow.draft()?.currentRevision || workflow.busy()
											}
											onClick={() => run(() => workflow.restore(revision.revision))}
										>
											{t("studio.restore")}
										</Button>
									</fieldset>
								)}
							</For>
							<Show when={history().length > 0 && history().length % 100 === 0}>
								<Button
									disabled={workflow.busy()}
									onClick={() =>
										run(async () => {
											const draft = workflow.draft();
											const before = history().at(-1)?.revision;
											if (draft && before)
												setHistory([
													...history(),
													...(await api.draftListRevisions(draft.id, before)),
												]);
										})
									}
								>
									{t("studio.loadMore")}
								</Button>
							</Show>
						</details>
					</main>
				</div>
			</Show>
			<Dialog open={creating()} onOpenChange={setCreating}>
				<Dialog.Portal>
					<Dialog.Overlay class="confirmation-overlay" />
					<Dialog.Content class="confirmation-dialog">
						<Dialog.Title>{copy() ? t("studio.copy") : t("studio.newRole")}</Dialog.Title>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								run(create);
							}}
						>
							<TextField value={name()}>
								<TextField.Label>{t("studio.name")}</TextField.Label>
								<TextField.Input required onInput={(event) => setName(event.currentTarget.value)} />
							</TextField>
							<TextField value={id()}>
								<TextField.Label>{t("studio.id")}</TextField.Label>
								<TextField.Description>{t("studio.idHint")}</TextField.Description>
								<TextField.Input
									required
									pattern="[a-z0-9][a-z0-9-]{0,63}"
									onInput={(event) => setId(event.currentTarget.value)}
								/>
							</TextField>
							<Show when={workflow.error()}>
								<p role="alert">{errorText()}</p>
							</Show>
							<div class="studio-tools">
								<Dialog.CloseButton as={Button} aria-label={t("messages.cancel")}>
									{t("messages.cancel")}
								</Dialog.CloseButton>
								<Button type="submit" data-variant="primary" disabled={workflow.busy()}>
									{t("studio.create")}
								</Button>
							</div>
						</form>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
			<Show when={trialOpen() && workflow.draft()}>
				{(draft) => (
					<StudioTrial
						api={api}
						draft={draft()}
						source={workflow.texts()["character.yaml"]}
						models={store.model
							.models()
							.filter((model) => model.enabled && model.readiness === "ready")}
						onClose={() => setTrialOpen(false)}
						onOpenSettings={props.onOpenSettings}
					/>
				)}
			</Show>
			<Dialog open={review()} onOpenChange={setReview}>
				<Dialog.Portal>
					<Dialog.Overlay class="confirmation-overlay" />
					<Dialog.Content
						class="studio-preview-dialog"
						onCloseAutoFocus={(event) => {
							if (focusingIssue) {
								event.preventDefault();
								focusingIssue = false;
							}
						}}
					>
						<Dialog.Title>{t("studio.applyReview")}</Dialog.Title>
						<p>
							{t("studio.applyDescription", {
								id: workflow.draft()?.characterId ?? "",
								revision: workflow.draft()?.currentRevision ?? 1,
								fileCount: files().length,
							})}
						</p>
						<Show when={reviewData() && workflow.draft()}>
							<StudioReview
								draft={workflow.draft()!}
								review={reviewData()!}
								api={api}
								onFile={(path, field) => {
									focusingIssue = true;
									setReview(false);
									run(async () => {
										setFields(false);
										await workflow.select(path);
										requestAnimationFrame(() => {
											if (!sourceEditor?.isConnected) return;
											const source = workflow.texts()[path] ?? "";
											const front = path.endsWith("/SKILL.md")
												? source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
												: undefined;
											const yaml = front?.[1] ?? source;
											const offset = front?.[1] ? source.indexOf(front[1]) : 0;
											const doc = parseDocument(yaml);
											const node = doc.getIn(
												field
													.split(".")
													.filter(Boolean)
													.map((key) => (/^\d+$/.test(key) ? Number(key) : key)),
												true,
											);
											const range = isNode(node) ? node.range : doc.errors[0]?.pos;
											sourceEditor?.focus();
											sourceEditor?.setSelectionRange(
												(range?.[0] ?? 0) + offset,
												(range?.[1] ?? 0) + offset,
											);
										});
									});
								}}
							/>
						</Show>
						<Show when={reviewData()?.migration?.changes.length}>
							<section class="studio-fields">
								<h3>{t("studio.migrationTitle")}</h3>
								<p>{t("studio.migrationHint")}</p>
								<For each={reviewData()?.migration?.changes}>
									{(change) => (
										<div>
											<strong>
												{change.scope} · {change.conversationId ?? "global"} · {change.field}
											</strong>
											<pre>
												{change.before} → {change.after}
											</pre>
										</div>
									)}
								</For>
								<Checkbox checked={migrationAccepted()} onChange={setMigrationAccepted}>
									<Checkbox.Input />
									<Checkbox.Control />
									<Checkbox.Label>{t("studio.migrationAccept")}</Checkbox.Label>
								</Checkbox>
							</section>
						</Show>
						<Show when={!reviewData()?.issues.length}>
							<p>{t("studio.applyHint")}</p>
						</Show>
						<div class="studio-tools">
							<Dialog.CloseButton as={Button} aria-label={t("messages.cancel")}>
								{t("messages.cancel")}
							</Dialog.CloseButton>
							<Button
								data-variant="primary"
								disabled={
									workflow.busy() ||
									!reviewData() ||
									Boolean(reviewData()?.issues.length) ||
									Boolean(reviewData()?.migration?.changes.length && !migrationAccepted())
								}
								onClick={() =>
									run(async () => {
										setReview(false);
										await workflow.apply(
											migrationAccepted() ? reviewData()?.migration?.token : undefined,
										);
										await refetch();
									})
								}
							>
								{t("studio.confirmApply")}
							</Button>
						</div>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
			<Show when={preview() && workflow.draft()}>
				<DraftPreview
					api={api}
					id={workflow.draft()!.id}
					files={workflow.draft()!.files}
					source={workflow.texts()["character.yaml"] ?? ""}
					file={preview()?.file}
					onClose={() => setPreview(undefined)}
				/>
			</Show>
		</section>
	);
}
