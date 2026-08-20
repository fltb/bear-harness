/**
 * ResultSpace: per-conversation, message-scoped dual-column result view
 * (Prototype 06 `result-mode`).
 *
 * The right column is not a modal and not a global panel: it renders only
 * the artifacts produced by the currently selected `runId`, anchored to the
 * `triggerMessageId` that started the work. Closing it clears only the
 * active conversation's selection and never mutates work, artifacts or the
 * audit trail; per-run last-viewed artifact preference survives close and
 * is restored on reopen.
 *
 * Owned pieces (this module):
 * - `ResultSpaceProvider` — per-conversation selection state + focus return.
 * - `useResultSpace` — consumer hook (open/close/selectArtifact/locate).
 * - `ResultSpace` — the right column layout, tabs and preview routing.
 * - `RESULT_LOCATE_EVENT` — the "定位到对话" DOM event the conversation
 *   timeline listens for to scroll/focus the source message.
 */

import { i18n, useTranslation } from "@bear-harness/i18n";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kobalte/core/button";
import { Tabs } from "@kobalte/core/tabs";
import {
	createContext,
	createEffect,
	createSignal,
	For,
	onCleanup,
	type ParentProps,
	Show,
	useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Icon } from "../Icon.js";
import { useCompanionStore } from "../stores/companion.js";
import type { Artifact } from "../stores/ipc.js";

/**
 * The selection that pins the right column to one work request. All five
 * fields are required at open time; the provider may re-resolve
 * `artifactId` to the run's last-viewed preference on reopen.
 */
export interface ResultSelection {
	conversationId: string;
	triggerMessageId: string;
	commissionId: string;
	runId: string;
	artifactId: string;
}

/** Detail payload of the `RESULT_LOCATE_EVENT` the timeline listens for. */
export interface ResultLocateDetail {
	conversationId: string;
	messageId: string;
}

/** DOM event dispatched by `locate()`; the timeline scrolls/focuses the message. */
export const RESULT_LOCATE_EVENT = "bear-result:locate";

export interface ResultSpaceApi {
	/** Active conversation's open selection, or undefined when closed. */
	selection(): ResultSelection | undefined;
	/**
	 * Open the result column for `selection`. `focusReturn` (usually the
	 * "查看成果" action-line button) receives focus on close. The effective
	 * artifactId restores the run's last-viewed preference when one exists.
	 */
	open(selection: ResultSelection, focusReturn?: HTMLElement): void;
	/** Close the active conversation's result view; restores opener focus. */
	close(): void;
	/** Switch the active tab; updates the selection and last-viewed preference. */
	selectArtifact(artifactId: string): void;
	/** Per-run last-viewed artifact preference (survives close). */
	lastArtifactId(runId: string): string | undefined;
	/** Dispatch the "定位到对话" event for the current selection. */
	locate(): void;
}

interface ResultEntry {
	selection: ResultSelection;
	focusReturn?: HTMLElement;
}

const ResultSpaceContext = createContext<ResultSpaceApi | undefined>(undefined);

export function ResultSpaceProvider(props: ParentProps) {
	const store = useCompanionStore();
	const [entries, setEntries] = createStore<Record<string, ResultEntry | undefined>>({});
	const [lastViewedByRun, setLastViewedByRun] = createStore<Record<string, string>>({});

	const selection = (): ResultSelection | undefined => {
		const conversationId = store.activeConversationId;
		return conversationId ? entries[conversationId]?.selection : undefined;
	};

	const open = (next: ResultSelection, focusReturn?: HTMLElement): void => {
		// Reopen restores the run's last-viewed tab (plan §5.4); the caller's
		// artifactId is used only when no preference exists yet.
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

	const lastArtifactId = (runId: string): string | undefined => lastViewedByRun[runId];

	const locate = (): void => {
		const current = selection();
		if (!current) return;
		window.dispatchEvent(
			new CustomEvent<ResultLocateDetail>(RESULT_LOCATE_EVENT, {
				detail: {
					conversationId: current.conversationId,
					messageId: current.triggerMessageId,
				},
			}),
		);
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

	const api: ResultSpaceApi = {
		selection,
		open,
		close,
		selectArtifact,
		lastArtifactId,
		locate,
	};

	return <ResultSpaceContext.Provider value={api}>{props.children}</ResultSpaceContext.Provider>;
}

export function useResultSpace(): ResultSpaceApi {
	const api = useContext(ResultSpaceContext);
	if (api === undefined) {
		throw new Error("useResultSpace must be used within ResultSpaceProvider");
	}
	return api;
}

// ---------------------------------------------------------------------------
// ResultSpace column
// ---------------------------------------------------------------------------

type PreviewKind = "text" | "markdown" | "image" | "audio" | "video" | "file";

function previewKind(mime: string): PreviewKind {
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
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/** Copy host bytes into an ArrayBuffer accepted by the DOM BlobPart type. */
function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Collapse whitespace and truncate the source message for the summary line. */
function summarize(text: string, maxLength = 72): string {
	const collapsed = text.trim().replace(/\s+/g, " ");
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, maxLength)}…`;
}

export function ResultSpace() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const { selection, close, selectArtifact, lastArtifactId, locate } = useResultSpace();

	const runArtifacts = (): Artifact[] => {
		const current = selection();
		if (!current) return [];
		return store.artifact
			.artifacts()
			.filter((artifact) => artifact.producerRunId === current.runId);
	};

	const activeArtifact = (): Artifact | undefined => {
		const current = selection();
		const artifacts = runArtifacts();
		if (!current || artifacts.length === 0) return undefined;
		const preferred = current.artifactId ?? lastArtifactId(current.runId);
		return artifacts.find((artifact) => artifact.id === preferred) ?? artifacts[0];
	};

	const commissionTitle = (): string => {
		const current = selection();
		if (!current) return t("work.result.title");
		return (
			store.commission.commissions().find((commission) => commission.id === current.commissionId)
				?.draft.title ?? t("work.result.title")
		);
	};

	const sourceSummary = (): string => {
		const current = selection();
		if (!current) return "";
		const message = store.activeMessages.find(
			(candidate) => candidate.id === current.triggerMessageId,
		);
		const content = message?.versions.at(-1)?.content ?? "";
		return summarize(content);
	};

	return (
		<Show when={selection()} keyed>
			{(current) => (
				<aside class="result-column" data-result-conversation={current.conversationId}>
					<section class="result-space" aria-label={t("work.result.title")}>
						<header class="result-header">
							<div class="result-heading">
								<h2>{commissionTitle()}</h2>
								<p class="result-source">
									{t("work.result.sourceFrom").replace("{summary}", sourceSummary())}
								</p>
							</div>
							<div class="result-actions">
								<Button data-control="command" class="result-locate" type="button" onClick={locate}>
									{t("work.result.locate")}
								</Button>
								<Button
									class="result-close"
									type="button"
									aria-label={t("work.result.close")}
									title={t("work.result.close")}
									onClick={close}
								>
									<Icon icon={faXmark} />
								</Button>
							</div>
						</header>
						<Show
							when={runArtifacts().length > 0}
							fallback={<p class="result-unavailable">{t("work.result.unavailable")}</p>}
						>
							<Tabs
								value={activeArtifact()?.id ?? ""}
								onChange={selectArtifact}
								aria-label={t("work.result.tabsLabel")}
							>
								<Tabs.List class="result-tabs" aria-label={t("work.result.tabsLabel")}>
									<For each={runArtifacts()}>
										{(artifact) => (
											<Tabs.Trigger
												class="result-tab"
												value={artifact.id}
												title={artifact.logicalName}
												id={`result-tab-${artifact.id}`}
											>
												{artifact.logicalName}
											</Tabs.Trigger>
										)}
									</For>
								</Tabs.List>
								<For each={runArtifacts()}>
									{(artifact) => (
										<Tabs.Content
											value={artifact.id}
											class="result-body"
											aria-labelledby={`result-tab-${artifact.id}`}
										>
											<ArtifactPreview artifact={artifact} />
										</Tabs.Content>
									)}
								</For>
							</Tabs>
						</Show>
					</section>
				</aside>
			)}
		</Show>
	);
}

// ---------------------------------------------------------------------------
// Artifact preview (safe first pass)
// ---------------------------------------------------------------------------

function ArtifactPreview(props: { artifact: Artifact }) {
	const store = useCompanionStore();
	const [textContent, setTextContent] = createSignal<string>();
	const [mediaSrc, setMediaSrc] = createSignal<string>();
	const [previewError, setPreviewError] = createSignal<string>();

	const kind = () => previewKind(props.artifact.mime);

	// Inline text/Markdown: host bytes decoded and rendered as text nodes.
	// Never injected as HTML.
	createEffect(() => {
		const artifact = props.artifact;
		if (kind() !== "text" && kind() !== "markdown") return;
		let cancelled = false;
		setTextContent(undefined);
		setPreviewError(undefined);
		void (async () => {
			try {
				const data = await store.artifact.read(artifact.id);
				if (cancelled) return;
				const bytes = decodeBase64(data.base64);
				setTextContent(new TextDecoder("utf-8").decode(bytes));
			} catch (error) {
				if (!cancelled) setPreviewError(messageOf(error));
			}
		})();
		onCleanup(() => {
			cancelled = true;
		});
	});

	// Image/audio/video: host-issued safe URL first (`bear-artifact://…`),
	// controlled blob fallback from host bytes. Both are host-owned; the
	// renderer never builds URLs from arbitrary paths.
	createEffect(() => {
		const artifact = props.artifact;
		if (kind() !== "image" && kind() !== "audio" && kind() !== "video") return;
		let cancelled = false;
		let objectUrl: string | undefined;
		setMediaSrc(undefined);
		setPreviewError(undefined);
		void (async () => {
			try {
				const hostUrl = await store.artifact.url(artifact.id);
				if (cancelled) return;
				if (hostUrl.length > 0) {
					setMediaSrc(hostUrl);
					return;
				}
				const data = await store.artifact.read(artifact.id);
				if (cancelled) return;
				const bytes = decodeBase64(data.base64);
				objectUrl = URL.createObjectURL(
					new Blob([copyToArrayBuffer(bytes)], { type: data.mime || artifact.mime }),
				);
				setMediaSrc(objectUrl);
			} catch (error) {
				if (!cancelled) setPreviewError(messageOf(error));
			}
		})();
		onCleanup(() => {
			cancelled = true;
			if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
		});
	});

	return (
		<Show
			when={previewError() === undefined}
			fallback={<p class="result-error">{previewError()}</p>}
		>
			<Show when={kind() === "text" || kind() === "markdown"}>
				<Show when={textContent() !== undefined} fallback={<p class="result-loading">…</p>}>
					<pre class="result-text">{textContent()}</pre>
				</Show>
			</Show>
			<Show when={kind() === "image"}>
				<Show when={mediaSrc()} keyed fallback={<p class="result-loading">…</p>}>
					{(source) => <img class="result-media" src={source} alt={props.artifact.logicalName} />}
				</Show>
			</Show>
			<Show when={kind() === "audio"}>
				<Show when={mediaSrc()} keyed fallback={<p class="result-loading">…</p>}>
					{(source) => (
						<audio
							class="result-media"
							src={source}
							controls
							preload="metadata"
							aria-label={props.artifact.logicalName}
						>
							<track
								kind="captions"
								src={`data:text/vtt;charset=utf-8,${encodeURIComponent(
									`WEBVTT\n\n00:00:00.000 --> 99:59:59.999\n${props.artifact.logicalName}`,
								)}`}
								srclang="und"
								default
							/>
						</audio>
					)}
				</Show>
			</Show>
			<Show when={kind() === "video"}>
				<Show when={mediaSrc()} keyed fallback={<p class="result-loading">…</p>}>
					{(source) => (
						<video
							class="result-media"
							src={source}
							controls
							preload="metadata"
							aria-label={props.artifact.logicalName}
						>
							<track
								kind="captions"
								src={`data:text/vtt;charset=utf-8,${encodeURIComponent(
									`WEBVTT\n\n00:00:00.000 --> 99:59:59.999\n${props.artifact.logicalName}`,
								)}`}
								srclang="und"
								default
							/>
						</video>
					)}
				</Show>
			</Show>
			<Show when={kind() === "file"}>
				<FileResultPage artifact={props.artifact} />
			</Show>
		</Show>
	);
}

/** Verified metadata/file page for artifact types without an inline preview. */
function FileResultPage(props: { artifact: Artifact }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const artifact = props.artifact;

	return (
		<div class="result-file-page">
			<p class="result-note">{t("work.result.filePage.previewUnavailable")}</p>
			<dl>
				<div>
					<dt>{t("work.result.filePage.name")}</dt>
					<dd>{artifact.logicalName}</dd>
				</div>
				<div>
					<dt>{t("work.result.filePage.mime")}</dt>
					<dd>{artifact.mime}</dd>
				</div>
				<div>
					<dt>{t("work.result.filePage.size")}</dt>
					<dd>{formatBytes(artifact.bytes)}</dd>
				</div>
				<div>
					<dt>{t("work.result.filePage.sha256")}</dt>
					<dd class="result-hash">{artifact.sha256}</dd>
				</div>
				<div>
					<dt>{t("work.result.filePage.status")}</dt>
					<dd>{t(`work.artifactStatuses.${artifact.status}`)}</dd>
				</div>
			</dl>
			<Button
				data-control="command"
				type="button"
				onClick={() => void store.artifact.download(artifact.id)}
			>
				{t("work.download")}
			</Button>
		</div>
	);
}
