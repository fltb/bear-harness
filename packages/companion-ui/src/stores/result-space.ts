import { i18n } from "@bear-harness/i18n";
import type { Accessor, ParentProps } from "solid-js";
import {
	createComponent,
	createContext,
	createEffect,
	createMemo,
	onCleanup,
	useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
import { useCompanionStore, type CompanionStore } from "./companion.js";
import type { Artifact } from "./ipc.js";

/**
 * The selection that pins the right column to one work request. All five
 * fields are required at open time; the store may re-resolve `artifactId` to
 * the run's last-viewed preference on reopen.
 */
export interface ResultSelection {
	conversationId: string;
	triggerEntryId: string;
	commissionId: string;
	runId: string;
	artifactId: string;
}

/** Detail payload of the `RESULT_LOCATE_EVENT` the timeline listens for. */
export interface ResultLocateDetail {
	conversationId: string;
	entryId: string;
}

/** DOM event dispatched by `locate()`; the timeline scrolls/focuses the message. */
export const RESULT_LOCATE_EVENT = "bear-result:locate";

export type PreviewKind = "text" | "markdown" | "image" | "audio" | "video" | "file";

export interface ResultPreviewState {
	textContent?: string;
	mediaSrc?: string;
	previewError?: string;
}

export interface ResultSpaceApi {
	/** Active conversation's open selection, or undefined when closed. */
	selection(): ResultSelection | undefined;
	/** Open the result column for `selection`; restores a run's tab preference. */
	open(selection: ResultSelection, focusReturn?: HTMLElement): void;
	/** Close the active conversation's result view; restores opener focus. */
	close(): void;
	/** Switch the active tab; updates the selection and last-viewed preference. */
	selectArtifact(artifactId: string): void;
	/** Per-run last-viewed artifact preference (survives close). */
	lastArtifactId(runId: string): string | undefined;
	/** Dispatch the "定位到对话" event for the current selection. */
	locate(): void;
	/** Artifacts produced by the currently selected run. */
	runArtifacts(): Artifact[];
	/** Currently selected artifact, falling back to the first run artifact. */
	activeArtifact(): Artifact | undefined;
	/** ID consumed by the tab control. */
	activeArtifactId(): string;
	/** Current commission title, with the standard empty-state fallback. */
	commissionTitle(): string;
	/** Collapsed source message summary for the current selection. */
	sourceSummary(): string;
	/** Whether the selected run has any artifacts to display. */
	hasArtifacts(): boolean;
	/** Reactive artifact preview state owned by this store. */
	preview(artifactId: string): Accessor<ResultPreviewState>;
	/** Reactive artifact preview kind selector. */
	previewKind(artifact: Pick<Artifact, "id" | "mime">): Accessor<PreviewKind>;
	/** Start or restart host-backed loading for an artifact preview. */
	loadPreview(artifact: Artifact): void;
	/** Cancel preview loading and release any renderer-created object URL. */
	releasePreview(artifactId: string): void;
}

interface ResultEntry {
	selection: ResultSelection;
	focusReturn?: HTMLElement;
}

const EMPTY_PREVIEW: ResultPreviewState = {};

function previewKindForMime(mime: string): PreviewKind {
	const value = mime.toLowerCase();
	if (
		value === "text/markdown" ||
		value === "text/x-markdown" ||
		value === "application/markdown"
	) {
		return "markdown";
	}
	if (value.startsWith("text/")) return "text";
	if (value.startsWith("image/")) return "image";
	if (value.startsWith("audio/")) return "audio";
	if (value.startsWith("video/")) return "video";
	return "file";
}

function decodeBase64(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** Copy host bytes into an ArrayBuffer accepted by the DOM BlobPart type. */
function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/** Collapse whitespace and truncate the source message for the summary line. */
function summarize(text: string, maxLength = 72): string {
	const collapsed = text.trim().replace(/\s+/g, " ");
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, maxLength)}…`;
}

/**
 * Dedicated result-workspace state and selectors. Host-backed artifacts are
 * read through the companion store; this store owns only the live view,
 * preferences, preview lifecycle, and DOM interaction state.
 */
export function createResultSpaceStore(store: CompanionStore): ResultSpaceApi {
	const [entries, setEntries] = createStore<Record<string, ResultEntry | undefined>>({});
	const [lastViewedByRun, setLastViewedByRun] = createStore<Record<string, string>>({});
	const [previews, setPreviews] = createStore<Record<string, ResultPreviewState>>({});
	const previewSelectors = new Map<string, Accessor<ResultPreviewState>>();
	const lastViewedByRunSelector = createMemo(() => lastViewedByRun);
	const previewKindSelectors = new Map<string, Accessor<PreviewKind>>();
	const previewLoads = new Map<
		string,
		{ token: number; kind: PreviewKind; objectUrl?: string }
	>();

	const activeEntry = createMemo<ResultEntry | undefined>(() => {
		const conversationId = store.activeConversationId;
		return conversationId === null ? undefined : entries[conversationId];
	});
	const selection = createMemo<ResultSelection | undefined>(() => activeEntry()?.selection);
	const lastViewedForSelection = createMemo<string | undefined>(() => {
		const current = selection();
		return current === undefined ? undefined : lastViewedByRunSelector()[current.runId];
	});
	const runArtifacts = createMemo<Artifact[]>(() => {
		const current = selection();
		if (current === undefined) return [];
		return store.artifact.artifacts().filter((artifact) => artifact.producerRunId === current.runId);
	});
	const activeArtifact = createMemo<Artifact | undefined>(() => {
		const current = selection();
		const artifacts = runArtifacts();
		if (current === undefined || artifacts.length === 0) return undefined;
		const preferred = current.artifactId || lastViewedForSelection();
		return artifacts.find((artifact) => artifact.id === preferred) ?? artifacts[0];
	});
	const activeArtifactId = createMemo(() => activeArtifact()?.id ?? "");
	const commissionTitle = createMemo(() => {
		const current = selection();
		if (current === undefined) return i18n.t("work.result.title");
		return (
			store.commission.commissions().find((commission) => commission.id === current.commissionId)?.draft
				.title ?? i18n.t("work.result.title")
		);
	});
	const sourceSummary = createMemo(() => {
		const current = selection();
		if (current === undefined) return "";
		const entry = store.activePiTimeline?.entries.find(
			(candidate) => candidate.id === current.triggerEntryId,
		);
		return entry?.kind === "message" && entry.role !== "tool"
			? summarize(entry.text ?? "")
			: "";
	});
	const hasArtifacts = createMemo(() => runArtifacts().length > 0);

	const open = (next: ResultSelection, focusReturn?: HTMLElement): void => {
		// Reopen restores the run's last-viewed tab; the caller's artifactId is
		// used only when no preference exists yet.
		const artifactId = lastViewedByRun[next.runId] ?? next.artifactId;
		setEntries(next.conversationId, {
			selection: { ...next, artifactId },
			focusReturn,
		});
	};

	const close = (): void => {
		const conversationId = store.activeConversationId;
		if (!conversationId) return;
		const entry = entries[conversationId];
		setEntries(conversationId, undefined);
		if (entry?.focusReturn && typeof entry.focusReturn.focus === "function") {
			entry.focusReturn.focus();
		}
	};

	const selectArtifact = (artifactId: string): void => {
		const conversationId = store.activeConversationId;
		if (!conversationId) return;
		const entry = entries[conversationId];
		if (!entry) return;
		setEntries(conversationId, {
			...entry,
			selection: { ...entry.selection, artifactId },
		});
		setLastViewedByRun(entry.selection.runId, artifactId);
	};

	const lastArtifactId = (runId: string): string | undefined => lastViewedByRunSelector()[runId];

	const locate = (): void => {
		const current = selection();
		if (!current) return;
		window.dispatchEvent(
			new CustomEvent<ResultLocateDetail>(RESULT_LOCATE_EVENT, {
				detail: {
					conversationId: current.conversationId,
					entryId: current.triggerEntryId,
				},
			}),
		);
	};

	const preview = (artifactId: string): Accessor<ResultPreviewState> => {
		const existing = previewSelectors.get(artifactId);
		if (existing !== undefined) return existing;
		const selector = createMemo<ResultPreviewState>(() => previews[artifactId] ?? EMPTY_PREVIEW);
		previewSelectors.set(artifactId, selector);
		return selector;
	};

	const previewKind = (artifact: Pick<Artifact, "id" | "mime">): Accessor<PreviewKind> => {
		const existing = previewKindSelectors.get(artifact.id);
		if (existing !== undefined) return existing;
		const selector = createMemo(() => previewKindForMime(artifact.mime));
		previewKindSelectors.set(artifact.id, selector);
		return selector;
	};

	const invalidatePreview = (artifactId: string): number => {
		const current = previewLoads.get(artifactId);
		if (current?.objectUrl !== undefined) URL.revokeObjectURL(current.objectUrl);
		const token = (current?.token ?? 0) + 1;
		previewLoads.set(artifactId, { token, kind: "file" });
		setPreviews(artifactId, {});
		return token;
	};

	const loadPreview = (artifact: Artifact): void => {
		const kind = previewKind(artifact)();
		if (kind === "file") return;
		const token = invalidatePreview(artifact.id);
		previewLoads.set(artifact.id, { token, kind });
		const isCurrent = (): boolean => previewLoads.get(artifact.id)?.token === token;
		if (kind === "text" || kind === "markdown") {
			void (async () => {
				try {
					const data = await store.artifact.read(artifact.id);
					if (!isCurrent()) return;
					const bytes = decodeBase64(data.base64);
					setPreviews(artifact.id, {
						textContent: new TextDecoder("utf-8").decode(bytes),
						previewError: undefined,
					});
				} catch (error) {
					if (isCurrent()) setPreviews(artifact.id, { previewError: messageOf(error) });
				}
			})();
			return;
		}
		void (async () => {
			try {
				const hostUrl = await store.artifact.url(artifact.id);
				if (!isCurrent()) return;
				if (hostUrl.length > 0) {
					setPreviews(artifact.id, { mediaSrc: hostUrl, previewError: undefined });
					return;
				}
				const data = await store.artifact.read(artifact.id);
				if (!isCurrent()) return;
				const bytes = decodeBase64(data.base64);
				const objectUrl = URL.createObjectURL(
					new Blob([copyToArrayBuffer(bytes)], { type: data.mime || artifact.mime }),
				);
				const current = previewLoads.get(artifact.id);
				if (current?.token !== token) {
					URL.revokeObjectURL(objectUrl);
					return;
				}
				previewLoads.set(artifact.id, { ...current, token, kind, objectUrl });
				setPreviews(artifact.id, { mediaSrc: objectUrl, previewError: undefined });
			} catch (error) {
				if (isCurrent()) setPreviews(artifact.id, { previewError: messageOf(error) });
			}
		})();
	};

	const releasePreview = (artifactId: string): void => {
		invalidatePreview(artifactId);
		previewLoads.delete(artifactId);
	};

	// `Esc` closes the active conversation's result view only (plan §6.1).
	createEffect(() => {
		if (!selection()) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			close();
		};
		window.addEventListener("keydown", onKeyDown);
		onCleanup(() => window.removeEventListener("keydown", onKeyDown));
	});

	return {
		selection,
		open,
		close,
		selectArtifact,
		lastArtifactId,
		locate,
		runArtifacts,
		activeArtifact,
		activeArtifactId,
		commissionTitle,
		sourceSummary,
		hasArtifacts,
		preview,
		previewKind,
		loadPreview,
		releasePreview,
	};
}

export const ResultSpaceContext = createContext<ResultSpaceApi | undefined>(undefined);

export function ResultSpaceProvider(props: ParentProps) {
	const store = useCompanionStore();
	const resultSpace = createResultSpaceStore(store);
	return createComponent(ResultSpaceContext.Provider, {
		value: resultSpace,
		get children() {
			return props.children;
		},
	});
}

export function useResultSpace(): ResultSpaceApi {
	const api = useContext(ResultSpaceContext);
	if (api === undefined) {
		throw new Error("useResultSpace must be used within ResultSpaceProvider");
	}
	return api;
}
