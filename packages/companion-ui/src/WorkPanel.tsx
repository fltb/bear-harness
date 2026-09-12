import { i18n, useTranslation } from "@bear-harness/i18n";
import { createQuery } from "@tanstack/solid-query";
import { createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { downloadBlob } from "./lib/browser-download.js";
import { finishMotionExitImmediately } from "./lib/motion.js";
import type {
	ArtifactActionResponse,
	ArtifactIdentity,
	ArtifactReadResponse,
	RunInfo,
	RunPermissionRequest,
} from "./stores/ipc.js";
import { type SelectedArtifact, useShellWorkflowStore } from "./stores/shell-workflows.js";
import { Button, Dialog } from "./ui/primitives.js";

const ARTIFACT_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_ARTIFACT_PREVIEW_BYTES = 64 * 1024 * 1024;
const MAX_BROWSER_DOWNLOAD_BYTES = 64 * 1024 * 1024;

type PreviewKind = "text" | "image" | "video" | "audio" | "pdf" | "unsupported";
type LoadedArtifactPreview =
	| { kind: "text"; mime: string; text: string }
	| { kind: "image" | "video" | "audio" | "pdf"; mime: string; blob: Blob };
type LoadedArtifactBytes = {
	artifact: ArtifactReadResponse["artifact"];
	chunks: ArrayBuffer[];
};

function previewKind(mime: string): PreviewKind {
	const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (normalized.startsWith("image/")) return "image";
	if (normalized.startsWith("video/")) return "video";
	if (normalized.startsWith("audio/")) return "audio";
	if (normalized === "application/pdf") return "pdf";
	if (
		normalized.startsWith("text/") ||
		normalized === "application/json" ||
		normalized.endsWith("+json") ||
		normalized === "application/xml" ||
		normalized.endsWith("+xml") ||
		normalized === "application/javascript" ||
		normalized === "application/yaml" ||
		normalized === "application/x-yaml"
	)
		return "text";
	return "unsupported";
}

function decodeArtifactChunk(base64: string): ArrayBuffer {
	let decoded: string;
	try {
		decoded = globalThis.atob(base64);
	} catch {
		throw new Error("artifact_chunk_invalid_base64");
	}
	if (decoded.length > ARTIFACT_READ_CHUNK_BYTES) throw new Error("artifact_chunk_exceeds_limit");
	const buffer = new ArrayBuffer(decoded.length);
	const bytes = new Uint8Array(buffer);
	for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
	return buffer;
}

async function readArtifactBytes(
	api: import("./stores/supplementary-api.js").ArtifactApi,
	identity: ArtifactIdentity,
	maxBytes: number,
	tooLargeReason: string,
): Promise<LoadedArtifactBytes> {
	let offset = 0;
	let expected: ArtifactReadResponse["artifact"] | undefined;
	const chunks: ArrayBuffer[] = [];
	while (true) {
		const page = await api.read({ ...identity, offset, length: ARTIFACT_READ_CHUNK_BYTES });
		if (page.artifact.id !== identity.artifactId || page.offset !== offset)
			throw new Error("artifact_chunk_identity_mismatch");
		expected ??= page.artifact;
		if (expected.bytes > maxBytes) throw new Error(tooLargeReason);
		if (
			page.artifact.id !== expected.id ||
			page.artifact.name !== expected.name ||
			page.artifact.mime !== expected.mime ||
			page.artifact.bytes !== expected.bytes ||
			page.artifact.sha256 !== expected.sha256 ||
			page.artifact.status !== expected.status ||
			page.artifact.createdAt !== expected.createdAt
		)
			throw new Error("artifact_metadata_changed_during_read");
		const chunk = decodeArtifactChunk(page.base64);
		if (
			page.nextOffset !== offset + chunk.byteLength ||
			page.nextOffset > expected.bytes ||
			(!page.eof && page.nextOffset <= offset) ||
			(page.eof && page.nextOffset !== expected.bytes)
		)
			throw new Error("artifact_chunk_range_invalid");
		chunks.push(chunk);
		if (page.eof) break;
		offset = page.nextOffset;
	}
	if (!expected) throw new Error("artifact_read_empty_response");
	return { artifact: expected, chunks };
}

async function readArtifactPreview(
	api: import("./stores/supplementary-api.js").ArtifactApi,
	identity: ArtifactIdentity,
): Promise<LoadedArtifactPreview> {
	const { artifact, chunks } = await readArtifactBytes(
		api,
		identity,
		MAX_ARTIFACT_PREVIEW_BYTES,
		"artifact_preview_too_large",
	);
	const kind = previewKind(artifact.mime);
	if (kind === "unsupported") throw new Error("artifact_preview_unsupported");
	const blob = new Blob(chunks, { type: artifact.mime });
	return kind === "text"
		? { kind, mime: artifact.mime, text: await blob.text() }
		: { kind, mime: artifact.mime, blob };
}

async function downloadArtifactInBrowser(
	api: import("./stores/supplementary-api.js").ArtifactApi,
	identity: ArtifactIdentity,
): Promise<void> {
	const { artifact, chunks } = await readArtifactBytes(
		api,
		identity,
		MAX_BROWSER_DOWNLOAD_BYTES,
		"artifact_browser_download_too_large",
	);
	downloadBlob(new Blob(chunks, { type: artifact.mime }), artifact.name);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

type ArtifactIssue = "corrupted" | "missing" | "unsupported" | "unavailable";

function artifactIssue(cause: unknown): ArtifactIssue {
	const reason =
		cause && typeof cause === "object" && "reason" in cause && typeof cause.reason === "string"
			? cause.reason
			: cause instanceof Error
				? cause.message
				: "";
	const kind =
		cause && typeof cause === "object" && "kind" in cause && typeof cause.kind === "string"
			? cause.kind
			: "";
	if (reason === "artifact_not_found" || kind === "not_found") return "missing";
	if (
		reason === "artifact_preview_unsupported" ||
		reason === "artifact_preview_too_large" ||
		reason === "artifact_browser_download_too_large"
	)
		return "unsupported";
	if (
		reason === "artifact_corrupted" ||
		reason.startsWith("artifact_chunk_") ||
		reason === "artifact_metadata_changed_during_read" ||
		reason === "artifact_read_empty_response"
	)
		return "corrupted";
	return "unavailable";
}
export function PermissionCard(props: { permission: RunPermissionRequest; run?: RunInfo }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const key = `${props.permission.runId}:${props.permission.requestId}`;
	const state = workflow.permissionAction(key);
	const run = createMemo(
		() => props.run ?? workflow.host.runs.find((item) => item.id === props.permission.runId),
	);
	const act = (action: () => Promise<unknown>) => {
		if (!state.busy()) workflow.runPermissionAction(key, action);
	};
	return (
		<div
			class="action-proposal needs-user"
			data-permission-request={props.permission.requestId}
			aria-busy={state.busy()}
		>
			<span class="system-label">{t("work.timeline.needsYou")}</span>
			<h3>{props.permission.prompt}</h3>
			<Show when={state.error()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<Show when={state.busy()}>
				<span role="status">{t("work.task.busy")}</span>
			</Show>
			<div class="work-actions">
				<For each={props.permission.options}>
					{(option) => {
						const id = createUniqueId();
						return (
							<Button
								type="button"
								class="permission-option"
								aria-labelledby={`${id}-name`}
								aria-describedby={`${id}-scope`}
								disabled={state.busy() || !run()?.actions?.includes("respondPermission")}
								onClick={() =>
									act(() =>
										workflow.host.run.respondPermission(
											props.permission.runId,
											props.permission.requestId,
											option.optionId,
										),
									)
								}
							>
								<span id={`${id}-name`}>{option.name}</span>
								<small id={`${id}-scope`} class="permission-scope">
									{option.kind}
								</small>
							</Button>
						);
					}}
				</For>
				<Show when={run()?.actions?.includes("cancel")}>
					<Button
						type="button"
						disabled={state.busy()}
						onClick={() => act(() => workflow.host.run.cancel(props.permission.runId))}
					>
						{t("work.timeline.stopRun")}
					</Button>
				</Show>
			</div>
		</div>
	);
}

export function WorkRunCard(props: { run: RunInfo }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const titleId = createUniqueId();
	const artifactState = workflow.runActionState(`${props.run.id}:artifact`);
	const origin = createMemo(
		() =>
			workflow.host.conversations?.find((item) => item.conversationId === props.run.conversationId)
				?.name ?? props.run.conversationId,
	);
	return (
		<article
			class="action-proposal run-controls task-row"
			aria-labelledby={titleId}
			data-run-id={props.run.id}
			data-run-status={props.run.status}
		>
			<span class="system-label">{t(`work.timeline.runStatuses.${props.run.status}`)}</span>
			<h3 id={titleId}>{props.run.title}</h3>
			<small class="task-origin">
				{t("work.task.origin")}: {origin()}
			</small>
			<Button type="button" class="task-inspect" onClick={() => workflow.openTask(props.run.id)}>
				{t("work.timeline.revealDetails")}
			</Button>
			<Show when={props.run.artifacts.length > 0}>
				<ul class="artifact-list" aria-label={t("work.result.tabsLabel")}>
					<For each={props.run.artifacts}>
						{(artifact) => (
							<li>
								<Button
									type="button"
									class="artifact-row"
									data-artifact-id={artifact.id}
									disabled={artifactState.busy()}
									aria-label={`${t("work.timeline.viewArtifacts")}: ${artifact.name}`}
									onClick={() =>
										void workflow.runRunAction(`${props.run.id}:artifact`, () =>
											workflow.openRunArtifact(props.run, artifact.id),
										)
									}
								>
									<div>
										<strong>{artifact.name}</strong>
										<span>
											{artifact.mime} · {formatBytes(artifact.bytes)}
										</span>
									</div>
									<span>{t("work.timeline.viewArtifacts")}</span>
								</Button>
							</li>
						)}
					</For>
				</ul>
			</Show>
			<Show when={artifactState.busy()}>
				<span role="status">{t("work.task.busy")}</span>
			</Show>
			<Show when={artifactState.error()}>{(error) => <span role="alert">{error()}</span>}</Show>
		</article>
	);
}

export function DelegatedRunCard(props: { runId: string }) {
	const workflow = useShellWorkflowStore();
	const [t] = useTranslation(undefined, { i18n });
	return (
		<Button
			type="button"
			class="task-inspect"
			data-run-id={props.runId}
			onClick={() => workflow.openTask(props.runId)}
		>
			{t("work.timeline.revealDetails")}
		</Button>
	);
}

function LoadedArtifactPreviewContent(props: { loaded: LoadedArtifactPreview; name: string }) {
	if (props.loaded.kind === "text")
		return <pre class="attachment-preview-text">{props.loaded.text}</pre>;
	const url = URL.createObjectURL(props.loaded.blob);
	onCleanup(() => URL.revokeObjectURL(url));
	switch (props.loaded.kind) {
		case "image":
			return <img src={url} alt={props.name} />;
		case "video":
			return (
				<>
					{/* biome-ignore lint/a11y/useMediaCaption: Artifact metadata has no caption-track field. */}
					<video src={url} controls aria-label={props.name} />
				</>
			);
		case "audio":
			return (
				<>
					{/* biome-ignore lint/a11y/useMediaCaption: Artifact metadata has no caption-track field. */}
					<audio src={url} controls aria-label={props.name} />
				</>
			);
		case "pdf":
			return <iframe src={url} title={props.name} sandbox="" />;
	}
}

function ArtifactPreviewPanel(props: { selection: SelectedArtifact }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const [open, setOpen] = createSignal(true);
	let completed = false;
	const completeClose = () => {
		if (open() || completed) return;
		completed = true;
		workflow.closeArtifact();
	};
	const requestClose = () => {
		if (!open()) return;
		setOpen(false);
		finishMotionExitImmediately(completeClose);
	};
	const kind = previewKind(props.selection.artifact.mime);
	const previewSupported =
		props.selection.artifact.status !== "verification_failed" &&
		kind !== "unsupported" &&
		props.selection.artifact.bytes <= MAX_ARTIFACT_PREVIEW_BYTES;
	const identity: ArtifactIdentity = {
		conversationId: props.selection.run.conversationId,
		runId: props.selection.run.id,
		artifactId: props.selection.artifact.id,
	};
	const preview = createQuery(() => ({
		queryKey: [
			"artifact-preview",
			identity.conversationId,
			identity.runId,
			identity.artifactId,
		] as const,
		queryFn: () => readArtifactPreview(workflow.host.artifact, identity),
		enabled: previewSupported,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		structuralSharing: false,
	}));
	const [actionBusy, setActionBusy] = createSignal(false);
	const [actionError, setActionError] = createSignal<string | null>(null);
	const [actionOutcome, setActionOutcome] = createSignal<ArtifactActionResponse["outcome"] | null>(
		null,
	);
	let actionGeneration = 0;
	let mounted = true;
	onCleanup(() => {
		mounted = false;
		actionGeneration += 1;
	});

	const runArtifactAction = async (action: "open" | "reveal" | "saveAs"): Promise<void> => {
		if (actionBusy()) return;
		const generation = ++actionGeneration;
		setActionBusy(true);
		setActionError(null);
		setActionOutcome(null);
		try {
			const outcome = await workflow.host.artifact[action](identity);
			if (action === "saveAs" && outcome.outcome === "unsupported") {
				await downloadArtifactInBrowser(workflow.host.artifact, identity);
				if (mounted && generation === actionGeneration) setActionOutcome("completed");
			} else if (mounted && generation === actionGeneration) setActionOutcome(outcome.outcome);
		} catch (cause) {
			if (mounted && generation === actionGeneration)
				setActionError(t(`work.result.issues.${artifactIssue(cause)}`));
		} finally {
			if (mounted && generation === actionGeneration) setActionBusy(false);
		}
	};
	const actionOutcomeLabel = () => {
		switch (actionOutcome()) {
			case "completed":
				return t("work.timeline.completed");
			case "cancelled":
				return t("work.timeline.runStatuses.cancelled");
			case "unsupported":
				return t("work.result.actionUnsupported");
			default:
				return null;
		}
	};
	const workLabels = createMemo(() => workflow.character()?.character.work_presentation?.labels);
	const previewIssue = (): ArtifactIssue | undefined => {
		if (props.selection.artifact.status === "verification_failed") return "corrupted";
		if (!previewSupported) return "unsupported";
		if (preview.error) return artifactIssue(preview.error);
		return undefined;
	};
	const previewState = () => {
		if (previewIssue()) return previewIssue();
		if (preview.data) return "ready";
		return "loading";
	};
	return (
		<Dialog open={open()} modal={false} forceMount onOpenChange={(next) => !next && requestClose()}>
			<Button
				type="button"
				class="artifact-preview-backdrop motion-fade"
				aria-label={t("work.result.close")}
				onClick={requestClose}
			/>
			<Dialog.Content
				class="attachment-preview-column motion-drawer-inline"
				data-artifact-preview={props.selection.artifact.id}
				aria-label={props.selection.artifact.name}
				onAnimationEnd={(event) => {
					if (event.target === event.currentTarget) completeClose();
				}}
				onAnimationCancel={(event) => {
					if (event.target === event.currentTarget) completeClose();
				}}
				onOpenAutoFocus={(event) => event.preventDefault()}
				onCloseAutoFocus={(event) => event.preventDefault()}
				onInteractOutside={(event) => event.preventDefault()}
			>
				<header>
					<div class="attachment-preview-heading">
						<small>{t("work.result.sourceFrom", { summary: props.selection.run.title })}</small>
						<strong>{props.selection.artifact.name}</strong>
					</div>
					<Button type="button" aria-label={t("work.result.close")} onClick={requestClose}>
						×
					</Button>
				</header>
				<div class="attachment-preview-body">
					<ul class="attachment-preview-files" aria-label={t("work.result.tabsLabel")}>
						<For each={props.selection.run.artifacts}>
							{(artifact) => (
								<li>
									<Button
										type="button"
										aria-current={artifact.id === props.selection.artifact.id ? "true" : undefined}
										onClick={() => workflow.selectArtifact(props.selection.run.id, artifact.id)}
									>
										<span>{artifact.name}</span>
										<small>
											{artifact.mime} · {formatBytes(artifact.bytes)}
										</small>
									</Button>
								</li>
							)}
						</For>
					</ul>
					<section
						class="attachment-preview-media"
						aria-label={props.selection.artifact.name}
						aria-live="polite"
						aria-busy={previewState() === "loading"}
						data-preview-state={previewState()}
					>
						<Show when={previewIssue()} keyed>
							{(issue) => (
								<p class="attachment-preview-error" role="alert">
									{t(`work.result.issues.${issue}`)}
								</p>
							)}
						</Show>
						<Show when={!previewIssue() && preview.isPending}>
							<p class="attachment-preview-status">{t("settings.loading")}</p>
						</Show>
						<Show when={preview.data} keyed>
							{(loaded) => (
								<LoadedArtifactPreviewContent
									loaded={loaded}
									name={props.selection.artifact.name}
								/>
							)}
						</Show>
					</section>
					<dl class="attachment-preview-metadata">
						<div>
							<dt>{t("work.result.filePage.name")}</dt>
							<dd>{props.selection.artifact.name}</dd>
						</div>
						<div>
							<dt>{t("work.result.filePage.mime")}</dt>
							<dd>{props.selection.artifact.mime}</dd>
						</div>
						<div>
							<dt>{t("work.result.filePage.size")}</dt>
							<dd>{formatBytes(props.selection.artifact.bytes)}</dd>
						</div>
						<div>
							<dt>{t("work.result.filePage.sha256")}</dt>
							<dd>
								<code>{props.selection.artifact.sha256}</code>
							</dd>
						</div>
						<div>
							<dt>{t("work.result.filePage.status")}</dt>
							<dd>{t(`work.artifactStatuses.${props.selection.artifact.status}`)}</dd>
						</div>
						<div>
							<dt>{t("work.result.createdAt")}</dt>
							<dd data-testid="artifact-created-at">{props.selection.artifact.createdAt}</dd>
						</div>
					</dl>
					<section class="attachment-preview-metadata" aria-label={t("work.result.provenance")}>
						<h3>{t("work.result.provenance")}</h3>
						<dl>
							<div>
								<dt>{t("work.result.producerRun")}</dt>
								<dd>
									<code data-testid="artifact-producer-run">{props.selection.run.id}</code>
								</dd>
							</div>
							<div>
								<dt>{t("work.result.executorProfile")}</dt>
								<dd>{props.selection.run.executorProfile}</dd>
							</div>
							<div>
								<dt>{t("work.result.triggerEntry")}</dt>
								<dd>
									<code data-testid="artifact-trigger-entry">
										{props.selection.run.triggerEntryId}
									</code>
								</dd>
							</div>
						</dl>
						<Show when={props.selection.run.summary} keyed>
							{(summary) => (
								<div>
									<strong>{t("work.result.summary")}</strong>
									<p>{summary}</p>
								</div>
							)}
						</Show>
						<h3>{t("work.result.evidence")}</h3>
						<Show
							when={props.selection.run.evidence.length > 0}
							fallback={<p>{t("work.result.noEvidence")}</p>}
						>
							<ul aria-label={t("work.result.evidence")}>
								<For each={props.selection.run.evidence}>
									{(item) => (
										<li>
											<strong>{item.kind}</strong>
											<Show when={item.summary}> · {item.summary}</Show>
											<small> · {item.createdAt}</small>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</section>
				</div>
				<footer class="attachment-preview-actions">
					<Button
						type="button"
						disabled={actionBusy()}
						onClick={() => void runArtifactAction("open")}
					>
						{workLabels()?.artifact_open ?? t("work.timeline.viewArtifacts")}
					</Button>
					<Button
						type="button"
						disabled={actionBusy()}
						onClick={() => void runArtifactAction("reveal")}
					>
						{workLabels()?.artifact_reveal ?? t("work.timeline.revealDetails")}
					</Button>
					<Button
						type="button"
						disabled={actionBusy()}
						onClick={() => void runArtifactAction("saveAs")}
					>
						{t("work.download")}
					</Button>
					<Show when={actionOutcomeLabel()} keyed>
						{(message) => <span role="status">{message}</span>}
					</Show>
					<Show when={actionError()} keyed>
						{(message) => <span role="alert">{message}</span>}
					</Show>
				</footer>
			</Dialog.Content>
		</Dialog>
	);
}

export function ArtifactPreview() {
	const workflow = useShellWorkflowStore();
	return (
		<Show when={workflow.selectedArtifact()} keyed>
			{(selection) => <ArtifactPreviewPanel selection={selection} />}
		</Show>
	);
}

export function WorkTimelineItem(props: { messageId: string }) {
	const workflow = useShellWorkflowStore();
	const representedRunIds = createMemo(() => {
		const ids = new Set<string>();
		for (const item of workflow.host.activeTimeline ?? []) {
			let details: unknown;
			if (
				item.kind === "entry" &&
				item.entry.type === "message" &&
				item.entry.message.role === "toolResult" &&
				item.entry.message.toolName === "host_delegate"
			) {
				details = item.entry.message.details;
			} else if (
				item.kind === "tool-execution" &&
				item.toolName === "host_delegate" &&
				item.result &&
				typeof item.result === "object" &&
				"details" in item.result
			) {
				details = item.result.details;
			}
			if (!details || typeof details !== "object" || !("data" in details)) continue;
			const data = details.data;
			if (
				data &&
				typeof data === "object" &&
				"accepted" in data &&
				data.accepted === true &&
				"executor" in data &&
				data.executor === "pi" &&
				"runId" in data &&
				typeof data.runId === "string"
			) {
				ids.add(data.runId);
			}
		}
		return ids;
	});
	const runsForMessage = workflow.runsForMessage(props.messageId);
	const runs = createMemo(() => runsForMessage().filter((run) => !representedRunIds().has(run.id)));
	return (
		<Show when={runs().length}>
			<div class="work-action-line" data-message-id={props.messageId}>
				<For each={runs()}>{(run) => <WorkRunCard run={run} />}</For>
			</div>
		</Show>
	);
}

export function PermissionLayer() {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const permission = createMemo(() => {
		const runIds = new Set(
			workflow.host.runs
				.filter(
					(run) =>
						run.conversationId === workflow.host.activeConversationId &&
						run.actions?.includes("respondPermission"),
				)
				.map((run) => run.id),
		);
		return workflow.host.run.pendingPermissions().find((item) => runIds.has(item.runId));
	});
	return (
		<Show when={permission()} keyed>
			{(current) => (
				<Dialog open modal onOpenChange={() => undefined}>
					<Dialog.Portal>
						<Dialog.Overlay class="work-permission-layer" />
						<Dialog.Content class="work-permission-dialog">
							<Dialog.Title class="sr-only">{t("work.timeline.needsYou")}</Dialog.Title>
							<PermissionCard permission={current} />
						</Dialog.Content>
					</Dialog.Portal>
				</Dialog>
			)}
		</Show>
	);
}
