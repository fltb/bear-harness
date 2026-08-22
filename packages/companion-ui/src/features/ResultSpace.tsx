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
 * - `ResultSpace` — the right column layout, tabs and preview routing.
 *
 * The result-workspace store owns selection, preference, preview and DOM
 * interaction state. This module only wires that context into the view.
 * `RESULT_LOCATE_EVENT` — the "定位到对话" DOM event the conversation
 * timeline listens for to scroll/focus the source message.
 */

import { i18n, useTranslation } from "@bear-harness/i18n";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kobalte/core/button";
import { Tabs } from "@kobalte/core/tabs";
import { createEffect, For, onCleanup, Show } from "solid-js";
import { Icon } from "../Icon.js";
import { useCompanionStore } from "../stores/companion.js";
import type { Artifact } from "../stores/ipc.js";
import { ResultSpaceProvider, useResultSpace } from "../stores/result-space.js";
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}


export {
	ResultSpaceProvider,
	useResultSpace,
	type ResultLocateDetail,
	type ResultSelection,
	type ResultSpaceApi,
	RESULT_LOCATE_EVENT,
} from "../stores/result-space.js";


// ---------------------------------------------------------------------------
// ResultSpace column
// ---------------------------------------------------------------------------


export function ResultSpace() {
	const [t] = useTranslation(undefined, { i18n });
	const {
		selection,
		close,
		selectArtifact,
		locate,
		runArtifacts,
		activeArtifactId,
		commissionTitle,
		sourceSummary,
		hasArtifacts,
	} = useResultSpace();

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
							when={hasArtifacts()}
							fallback={<p class="result-unavailable">{t("work.result.unavailable")}</p>}
						>
							<Tabs
								value={activeArtifactId()}
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
	const resultSpace = useResultSpace();
	const preview = resultSpace.preview(props.artifact.id);
	const kind = resultSpace.previewKind(props.artifact);

	// Preview bytes and URLs remain workspace state; this component only wires
	// their host-backed lifecycle to the mounted artifact view.
	createEffect(() => {
		const artifact = props.artifact;
		resultSpace.loadPreview(artifact);
		onCleanup(() => resultSpace.releasePreview(artifact.id));
	});

	return (
		<Show
			when={preview().previewError === undefined}
			fallback={<p class="result-error">{preview().previewError}</p>}
		>
			<Show when={kind() === "text" || kind() === "markdown"}>
				<Show
					when={preview().textContent !== undefined}
					fallback={<p class="result-loading">…</p>}
				>
					<pre class="result-text">{preview().textContent}</pre>
				</Show>
			</Show>
			<Show when={kind() === "image"}>
				<Show when={preview().mediaSrc} keyed fallback={<p class="result-loading">…</p>}>
					{(source) => <img class="result-media" src={source} alt={props.artifact.logicalName} />}
				</Show>
			</Show>
			<Show when={kind() === "audio"}>
				<Show when={preview().mediaSrc} keyed fallback={<p class="result-loading">…</p>}>
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
				<Show when={preview().mediaSrc} keyed fallback={<p class="result-loading">…</p>}>
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
					<dd>{t(`work.artifactStatuses.${artifact.status}` as never)}</dd>
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
