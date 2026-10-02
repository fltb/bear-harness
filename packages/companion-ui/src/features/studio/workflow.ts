import { createSignal, onCleanup } from "solid-js";
import type { CharacterDraft, CharacterDraftFiles } from "../../stores/ipc.js";
import type { CharacterApi } from "../../stores/supplementary-api.js";

/** Author edits only. Pi state remains in the application store while this page is open. */
export function createStudioWorkflow(api: CharacterApi) {
	const [undoRevisions, setUndoRevisions] = createSignal<number[]>();
	const [redoRevisions, setRedoRevisions] = createSignal<number[]>([]);
	const [draft, setDraft] = createSignal<CharacterDraft>();
	const [texts, setTexts] = createSignal<Record<string, string>>({});
	const [pending, setPending] = createSignal<CharacterDraftFiles>({});
	const [saving, setSaving] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal("");
	const [applied, setApplied] = createSignal(false);
	const [selected, setSelected] = createSignal("character.yaml");
	const [loaded, setLoaded] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let save: Promise<void> | undefined;
	let selection = 0;
	const describe = (cause: unknown) =>
		cause && typeof cause === "object" && "reason" in cause
			? String(cause.reason)
			: cause instanceof Error
				? cause.message
				: String(cause);
	const dirty = () => Object.keys(pending()).length > 0;
	async function flush(): Promise<void> {
		clearTimeout(timer);
		if (save) return save;
		const current = draft();
		if (!current || !dirty()) return;
		setSaving(true);
		save = (async () => {
			while (dirty()) {
				const files = pending();
				setPending({});
				try {
					const next = await api.draftPatch(
						current.id,
						draft()?.currentRevision ?? current.currentRevision,
						files,
					);
					recordRevision();
					setDraft(next);
					setError("");
				} catch (cause) {
					setPending((newer) => ({ ...files, ...newer }));
					setError(describe(cause));
					throw cause;
				}
			}
		})().finally(() => {
			setSaving(false);
			save = undefined;
		});
		return save;
	}
	function recordRevision() {
		const current = draft();
		if (current) setUndoRevisions((all) => (all ? [...all, current.currentRevision] : undefined));
		setRedoRevisions([]);
	}
	function edit(path: string, content: string) {
		setTexts((all) => ({ ...all, [path]: content }));
		setPending((all) => ({ ...all, [path]: { encoding: "utf8", content } }));
		setApplied(false);
		clearTimeout(timer);
		timer = setTimeout(() => void flush().catch(() => undefined), 800);
	}
	async function select(path: string) {
		setSelected(path);
		setLoaded(false);
		const seq = ++selection;
		if (texts()[path] !== undefined) {
			setLoaded(true);
			return;
		}
		const current = draft();
		if (!current) return;
		if (current.files[path]?.encoding !== "utf8") {
			setLoaded(true);
			return;
		}
		const bytes = await api.draftFile(current.id, path);
		if (seq !== selection || current.id !== draft()?.id) return;
		setTexts((all) => ({ ...all, [path]: new TextDecoder().decode(bytes) }));
		setLoaded(true);
	}
	async function open(next: CharacterDraft) {
		await flush();
		setUndoRevisions(undefined);
		setRedoRevisions([]);
		setDraft(next);
		setTexts({});
		setPending({});
		setError("");
		setApplied(false);
		await select("character.yaml");
	}
	async function action(work: () => Promise<void>) {
		if (busy()) return;
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (cause) {
			setError(describe(cause));
		} finally {
			setBusy(false);
		}
	}
	async function patch(files: CharacterDraftFiles) {
		await flush();
		const current = draft();
		if (!current) return;
		const next = await api.draftPatch(current.id, current.currentRevision, files);
		recordRevision();
		setDraft(next);
		setApplied(false);
		setTexts((all) =>
			Object.fromEntries(Object.entries(all).filter(([path]) => !Object.hasOwn(files, path))),
		);
	}
	async function apply(migrationToken?: string) {
		await flush();
		const current = draft();
		if (!current) return;
		await api.draftValidate(current.id, current.currentRevision);
		setDraft(await api.draftPublish(current.id, current.currentRevision, migrationToken));
		setApplied(true);
	}
	async function restore(revision: number) {
		await flush();
		const current = draft();
		if (!current) return;
		const next = await api.draftRestoreRevision(current.id, current.currentRevision, revision);
		await open(next);
	}
	async function undo(redo = false) {
		await flush();
		const current = draft();
		if (!current) return;
		if (!redo && undoRevisions() === undefined) {
			const revisions = await api.draftListRevisions(current.id);
			setUndoRevisions(
				revisions
					.filter((item) => item.revision < current.currentRevision)
					.map((item) => item.revision)
					.reverse(),
			);
		}
		const stack = redo ? redoRevisions() : (undoRevisions() ?? []);
		const target = stack.at(-1);
		if (target === undefined) return;
		const next = await api.draftRestoreRevision(current.id, current.currentRevision, target);
		if (redo) {
			setRedoRevisions(stack.slice(0, -1));
			setUndoRevisions((all) => [...(all ?? []), current.currentRevision]);
		} else {
			setUndoRevisions(stack.slice(0, -1));
			setRedoRevisions((all) => [...all, current.currentRevision]);
		}
		setDraft(next);
		setTexts({});
		setApplied(false);
		await select(next.files[selected()] ? selected() : "character.yaml");
	}
	const onUnload = (event: BeforeUnloadEvent) => {
		if (dirty() || saving()) {
			event.preventDefault();
			event.returnValue = "";
		}
	};
	const onKey = (event: KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void flush().catch(() => undefined);
		}
	};
	window.addEventListener("beforeunload", onUnload);
	window.addEventListener("keydown", onKey);
	onCleanup(() => {
		clearTimeout(timer);
		window.removeEventListener("beforeunload", onUnload);
		window.removeEventListener("keydown", onKey);
	});
	return {
		draft,
		undo,
		retainHistory: (revisions: number[]) => {
			setUndoRevisions((all) => all?.filter((revision) => revisions.includes(revision)));
			setRedoRevisions((all) => all.filter((revision) => revisions.includes(revision)));
		},
		canUndo: () => undoRevisions()?.length ?? ((draft()?.currentRevision ?? 1) > 1 ? 1 : 0),
		canRedo: () => redoRevisions().length,
		texts,
		dirty,
		saving,
		busy,
		error,
		applied,
		selected,
		loaded,
		edit,
		select,
		open,
		action,
		flush,
		patch,
		apply,
		restore,
		clear: () => {
			clearTimeout(timer);
			setDraft(undefined);
			setUndoRevisions(undefined);
			setRedoRevisions([]);
			setTexts({});
			setPending({});
			setError("");
		},
	};
}
