import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { downloadBlob } from "../../lib/browser-download.js";
import { useCompanionStore } from "../../stores/companion.js";
import { Button, Dialog, FileField, TextField } from "../../ui/primitives.js";
import { ManifestFields } from "./ManifestFields.js";
import { createStudioWorkflow } from "./workflow.js";

export function CharacterStudio(props: { onClose(): void; initialCharacterId?: string }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const api = store.characters;
	const workflow = createStudioWorkflow(api);
	const [library, { refetch }] = createResource(async () => {
		const [characters, drafts] = await Promise.all([api.list(), api.draftList()]);
		return { characters: characters.characters, drafts };
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
		const existing = (await api.draftList()).find((item) => item.characterId === characterId);
		await workflow.open(
			existing ? await api.draftGet(existing.id) : await api.draftCreate({ characterId }),
		);
		setFields(true);
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
		await workflow.patch({ [name]: { encoding: "utf8", content: "" } });
		setPath("");
		setFields(false);
		await workflow.select(name);
	}
	async function upload(files: File[]) {
		await workflow.flush();
		for (const file of files) {
			if (file.size > 8 * 1024 * 1024) throw new Error(t("studio.fileLimit"));
			const bytes = new Uint8Array(await file.arrayBuffer());
			let binary = "";
			for (let start = 0; start < bytes.length; start += 16384)
				binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
			const target = `assets/${file.name}`;
			if (
				workflow.draft()?.files[target] &&
				!window.confirm(t("studio.replaceFile", { path: target }))
			)
				continue;
			await workflow.patch({ [target]: { encoding: "base64", content: btoa(binary) } });
			setFields(false);
			await workflow.select(target);
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
								await api.draftValidate(draft.id, draft.currentRevision);
								setReview(true);
							})
						}
					>
						{t("studio.apply")}
					</Button>
				</Show>
			</header>
			<Show when={workflow.error() || library.error}>
				<div class="studio-error" role="alert">
					<p>{errorText() || String(library.error)}</p>
					<Button
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
							onClick={() =>
								run(async () => {
									await workflow.flush();
									const current = workflow.draft();
									if (!current) return;
									await workflow.open(await api.draftCreate({ characterId: current.characterId }));
									setFields(true);
								})
							}
						>
							{t("studio.freshDraft")}
						</Button>
					</Show>
					<Show when={workflow.dirty()}>
						<Button
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
											<Button data-variant="primary" onClick={() => run(() => edit(character.id))}>
												{libraryData()?.drafts.some((draft) => draft.characterId === character.id)
													? t("studio.resume")
													: t("studio.edit")}
											</Button>
											<Button
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
								<For each={libraryData()?.drafts}>
									{(draft) => (
										<div class="studio-draft-row">
											<span>
												{draft.characterId} · {draft.updatedAt}
											</span>
											<Button
												onClick={() =>
													run(async () => {
														await workflow.open(await api.draftGet(draft.id));
														setFields(true);
													})
												}
											>
												{t("studio.resume")}
											</Button>
										</div>
									)}
								</For>
							</section>
						</Show>
					</div>
				}
			>
				<div class="studio-workspace">
					<nav class="studio-navigation" aria-label={t("studio.contents")}>
						<Button
							aria-current={fields() ? "page" : undefined}
							onClick={() =>
								run(async () => {
									await workflow.select("character.yaml");
									setFields(true);
								})
							}
						>
							{t("studio.commonFields")}
						</Button>
						<p class="field-hint">{t("studio.fileHint")}</p>
						<For each={files()}>
							{(file) => (
								<Button
									class="studio-file"
									aria-current={!fields() && workflow.selected() === file ? "page" : undefined}
									onClick={() =>
										run(async () => {
											setFields(false);
											await workflow.select(file);
										})
									}
								>
									{file}
								</Button>
							)}
						</For>
					</nav>
					<main class="studio-editor">
						<Show when={workflow.loaded()} fallback={<p role="status">{t("studio.loading")}</p>}>
							<Show
								when={fields()}
								fallback={
									<>
										<div class="studio-tools">
											<h2>{workflow.selected()}</h2>
											<Button onClick={() => run(download)}>{t("studio.downloadFile")}</Button>
											<Show when={workflow.selected() !== "character.yaml"}>
												<Button
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
											<TextField class="studio-source" value={text()} disabled={workflow.busy()}>
												<TextField.Label>{t("studio.source")}</TextField.Label>
												<TextField.TextArea
													spellcheck={false}
													rows={24}
													onInput={(event) =>
														workflow.edit(workflow.selected(), event.currentTarget.value)
													}
												/>
											</TextField>
										</Show>
									</>
								}
							>
								<p class="field-hint">{t("studio.fieldsHint")}</p>
								<ManifestFields
									source={workflow.texts()["character.yaml"] ?? ""}
									disabled={workflow.busy()}
									onChange={(value) => workflow.edit("character.yaml", value)}
								/>
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
								<Dialog.CloseButton as={Button}>{t("messages.cancel")}</Dialog.CloseButton>
								<Button type="submit" data-variant="primary" disabled={workflow.busy()}>
									{t("studio.create")}
								</Button>
							</div>
						</form>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
			<Dialog open={review()} onOpenChange={setReview}>
				<Dialog.Portal>
					<Dialog.Overlay class="confirmation-overlay" />
					<Dialog.Content class="confirmation-dialog">
						<Dialog.Title>{t("studio.applyReview")}</Dialog.Title>
						<p>
							{t("studio.applyDescription", {
								id: workflow.draft()?.characterId ?? "",
								revision: workflow.draft()?.currentRevision ?? 1,
								fileCount: files().length,
							})}
						</p>
						<p>{t("studio.applyHint")}</p>
						<div class="studio-tools">
							<Dialog.CloseButton as={Button}>{t("messages.cancel")}</Dialog.CloseButton>
							<Button
								data-variant="primary"
								disabled={workflow.busy()}
								onClick={() =>
									run(async () => {
										setReview(false);
										await workflow.apply();
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
		</section>
	);
}
