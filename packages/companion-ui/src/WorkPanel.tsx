import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, For, Show } from "solid-js";
import { useResultSpace } from "./features/ResultSpace.js";
import { type CharacterDisplay, useCompanionStore } from "./stores/companion.js";
import type { Commission, RunInfo, RunPermissionRequest } from "./stores/ipc.js";

/**
 * Message-scoped work action lines (plan §4). WorkTimelineItem sits below the
 * user message that triggered it and renders every commission whose
 * `triggerMessageId` equals that message id — never a global aggregation of
 * the current conversation's work. Each commission line shows its proposal,
 * run controls, pending permissions, completion/failure state and a collapsed
 * tool-trace detail. Role wording (`character.work_presentation.labels`)
 * covers titles and buttons only; every absent label falls back to i18n.
 */

type WorkLabels = NonNullable<CharacterDisplay["character"]["work_presentation"]>["labels"];

function steerable(status: RunInfo["status"]): boolean {
	return status === "running" || status === "needs_user";
}

function interruptible(status: RunInfo["status"]): boolean {
	return status === "enqueued" || status === "running" || status === "needs_user";
}

function isFailure(status: RunInfo["status"]): boolean {
	return status === "failed" || status === "cancelled" || status === "forced_termination";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * ResultSpace context is optional here: the provider wraps the app shell, but
 * components must not crash when rendered without it (e.g. in isolation).
 */
function useOptionalResultSpace() {
	try {
		return useResultSpace();
	} catch {
		return undefined;
	}
}

/** The proposal card for a draft/approved commission. */
export function WorkProposalCard(props: { commission: Commission; labels?: WorkLabels }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [busy, setBusy] = createSignal(false);
	const [actionError, setActionError] = createSignal<string | null>(null);
	const runAction = async (action: () => Promise<unknown>): Promise<void> => {
		setBusy(true);
		setActionError(null);
		const before = store.errorMetadata;
		try {
			await action();
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) setActionError(retained.message);
		} catch (cause) {
			setActionError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const start = () =>
		void runAction(async () => {
			if (props.commission.status === "draft") {
				await store.commission.approve(props.commission.id, props.commission.draft.hash);
			}
			await store.commission.launch(props.commission.id, "pi-product-managed");
		});
	const reject = () => void runAction(() => store.commission.reject(props.commission.id));

	return (
		<div class="action-proposal" data-commission-id={props.commission.id}>
			<div>
				<span class="system-label">{props.labels?.proposal ?? t("work.timeline.proposal")}</span>
				<h3>{props.commission.draft.title}</h3>
				<p>{props.commission.draft.description}</p>
			</div>
			<Show when={actionError()}>
				{(error) => (
					<span class="status-line error" role="alert">
						{t("messages.operationFailedPrefix")}
						{error()}
					</span>
				)}
			</Show>
			<div class="scope-list">
				<Show when={props.commission.draft.reads.length > 0}>
					<p>
						<strong>{t("work.reads")}</strong>
						{props.commission.draft.reads.join("、")}
					</p>
				</Show>
				<Show when={props.commission.draft.writes.length > 0}>
					<p>
						<strong>{t("work.writes")}</strong>
						{props.commission.draft.writes.join("、")}
					</p>
				</Show>
				<p>
					<strong>{t("work.network")}</strong>
					{props.commission.draft.networkAllowed ? t("work.networkYes") : t("work.networkNo")}
				</p>
			</div>
			<div class="work-actions">
				<Button data-control="command" type="button" disabled={busy()} onClick={start}>
					{props.labels?.approve ?? t("work.timeline.start")}
				</Button>
				<Button data-control="command" type="button" disabled={busy()} onClick={reject}>
					{props.labels?.reject ?? t("work.timeline.cancel")}
				</Button>
			</div>
		</div>
	);
}

/** One pending permission hanging inside the run card that raised it. */
export function PermissionCard(props: { permission: RunPermissionRequest }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [busy, setBusy] = createSignal(false);
	const [actionError, setActionError] = createSignal<string | null>(null);
	const runAction = (action: () => Promise<unknown>) => {
		setBusy(true);
		setActionError(null);
		const before = store.errorMetadata;
		void Promise.resolve()
			.then(action)
			.then(() => {
				const retained = store.errorMetadata;
				if (retained !== null && retained !== before) setActionError(retained.message);
			})
			.catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setBusy(false));
	};

	return (
		<div class="action-proposal needs-user" data-permission-request={props.permission.requestId}>
			<span class="system-label">{t("work.timeline.needsYou")}</span>
			<h3>{props.permission.prompt}</h3>
			<Show when={actionError()}>
				{(error) => (
					<span class="status-line error" role="alert">
						{t("messages.operationFailedPrefix")}
						{error()}
					</span>
				)}
			</Show>
			<div class="work-actions">
				<For each={props.permission.options}>
					{(option) => (
						<Button
							data-control="command"
							type="button"
							disabled={busy()}
							onClick={() =>
								runAction(() =>
									store.run.respondPermission(
										props.permission.runId,
										props.permission.requestId,
										option.optionId,
									),
								)
							}
						>
							{option.kind.includes("reject")
								? t("work.timeline.permissionDeny")
								: t("work.timeline.permissionAllow")}
						</Button>
					)}
				</For>
				<Button
					data-control="command"
					type="button"
					disabled={busy()}
					onClick={() => runAction(() => store.run.cancel(props.permission.runId))}
				>
					{t("work.timeline.stopRun")}
				</Button>
			</div>
		</div>
	);
}

/**
 * One run card: status, steering, interrupt/resume, the permissions it
 * raised, its completion/failure state and a collapsed tool-trace detail.
 */
export function WorkRunCard(props: {
	commission: Commission;
	run: RunInfo;
	messageId: string;
	labels?: WorkLabels;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [busy, setBusy] = createSignal(false);
	const [actionError, setActionError] = createSignal<string | null>(null);
	const runAction = async (action: () => Promise<unknown>): Promise<boolean> => {
		setBusy(true);
		setActionError(null);
		const before = store.errorMetadata;
		try {
			await action();
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) {
				setActionError(retained.message);
				return false;
			}
			return true;
		} catch (cause) {
			setActionError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const [steerText, setSteerText] = createSignal("");
	const resultSpace = useOptionalResultSpace();

	const artifacts = () =>
		store.artifact.artifacts().filter((artifact) => artifact.producerRunId === props.run.id);
	const permissions = () =>
		store.run.pendingPermissions().filter((permission) => permission.runId === props.run.id);
	const conversationId = () => props.commission.conversationId ?? store.activeConversationId ?? "";

	const statusLabel = () => {
		switch (props.run.status) {
			case "running":
				return props.labels?.running ?? t("work.timeline.runStatuses.running");
			case "needs_user":
				return props.labels?.needs_user ?? t("work.timeline.runStatuses.needs_user");
			case "interrupted":
				return props.labels?.interrupted ?? t("work.timeline.runStatuses.interrupted");
			case "completed":
				return props.labels?.completed ?? t("work.timeline.completed");
			case "failed":
			case "cancelled":
			case "forced_termination":
				return props.labels?.failed ?? t("work.timeline.failed");
			default:
				return t(`work.timeline.runStatuses.${props.run.status}`) ?? t("threadHead.statusUpdating");
		}
	};
	const selection = () => resultSpace?.selection();
	const isResultOpen = () => selection()?.runId === props.run.id;

	const submitSteer = async (): Promise<void> => {
		const instruction = steerText().trim();
		if (!instruction || busy()) return;
		if (await runAction(() => store.run.steer(props.run.id, instruction))) setSteerText("");
	};

	const openResults = (event: MouseEvent) => {
		const first = artifacts()[0];
		if (!first || !resultSpace) return;
		resultSpace.open(
			{
				conversationId: conversationId(),
				triggerMessageId: props.messageId,
				commissionId: props.commission.id,
				runId: props.run.id,
				artifactId: first.id,
			},
			event.currentTarget as HTMLButtonElement,
		);
	};

	return (
		<div
			class="action-proposal run-controls"
			data-run-status={props.run.status}
			data-result-open={isResultOpen() ? "" : undefined}
		>
			<span class="system-label">{statusLabel()}</span>
			<h3>{props.commission.draft.title}</h3>
			<Show when={actionError()}>
				{(error) => (
					<span class="status-line error" role="alert">
						{t("messages.operationFailedPrefix")}
						{error()}
					</span>
				)}
			</Show>

			<Show when={steerable(props.run.status)}>
				<div class="steer-row">
					<TextField>
						<TextField.Input
							type="text"
							class="steer-input"
							aria-label={t("work.steerInputLabel")}
							placeholder={props.labels?.steer_placeholder ?? t("work.timeline.steerPlaceholder")}
							value={steerText()}
							onInput={(event) => setSteerText(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void submitSteer();
								}
							}}
						/>
					</TextField>
					<Button
						data-control="command"
						type="button"
						disabled={busy() || !steerText().trim()}
						onClick={() => void submitSteer()}
					>
						{t("work.timeline.steer")}
					</Button>
				</div>
			</Show>

			<Show when={interruptible(props.run.status) || props.run.status === "interrupted"}>
				<div class="work-actions">
					<Show when={interruptible(props.run.status)}>
						<Button
							data-control="command"
							type="button"
							disabled={busy()}
							onClick={() => void runAction(() => store.run.interrupt(props.run.id))}
						>
							{props.labels?.interrupt ?? t("work.timeline.interrupt")}
						</Button>
					</Show>
					<Show when={props.run.status === "interrupted"}>
						<Button
							data-control="command"
							type="button"
							disabled={busy()}
							onClick={() => void runAction(() => store.run.resume(props.run.id))}
						>
							{props.labels?.resume ?? t("work.timeline.resume")}
						</Button>
					</Show>
				</div>
			</Show>

			<For each={permissions()}>{(permission) => <PermissionCard permission={permission} />}</For>

			<Show when={props.run.status === "completed" && artifacts().length > 0}>
				<div class="completion-card">
					<span class="system-label">
						{props.labels?.completed ?? t("work.timeline.completed")}
					</span>
					<p class="completion-count">
						{t("work.timeline.resultCount").replace("{count}", String(artifacts().length))}
					</p>
					<div class="artifact-list">
						<For each={artifacts()}>
							{(artifact) => (
								<div class="artifact-row">
									<div>
										<strong>{artifact.logicalName}</strong>
										<span>
											{formatBytes(artifact.bytes)} ·{" "}
											{t(`work.artifactStatuses.${artifact.status}`)}
										</span>
									</div>
									<Button
										data-control="command"
										type="button"
										onClick={() => void store.artifact.download(artifact.id)}
									>
										{t("work.download")}
									</Button>
								</div>
							)}
						</For>
					</div>
					<div class="work-actions">
						<Button data-control="command" type="button" class="primary-tool" onClick={openResults}>
							{props.labels?.artifact_open ?? t("work.timeline.viewArtifacts")}
						</Button>
					</div>
				</div>
			</Show>

			<Show when={isFailure(props.run.status)}>
				<div class="failure-card">
					<span class="system-label">{props.labels?.failed ?? t("work.timeline.failed")}</span>
					<p>{t(`work.timeline.runStatuses.${props.run.status}`)}</p>
				</div>
			</Show>

			<Show when={artifacts().length > 0}>
				<details class="tool-trace">
					<summary>{props.labels?.artifact_reveal ?? t("work.timeline.revealDetails")}</summary>
					<ul>
						<For each={artifacts()}>
							{(artifact) => (
								<li data-status={artifact.status}>
									<strong>{artifact.logicalName}</strong>
									<span>
										{formatBytes(artifact.bytes)} · {t(`work.artifactStatuses.${artifact.status}`)}
									</span>
									<Button
										data-control="command"
										type="button"
										onClick={() => void store.artifact.download(artifact.id)}
									>
										{t("work.download")}
									</Button>
								</li>
							)}
						</For>
					</ul>
				</details>
			</Show>
		</div>
	);
}

/**
 * The message-scoped action line: renders only work whose
 * `triggerMessageId` equals `messageId`. Unrelated messages render nothing.
 */
export function WorkTimelineItem(props: {
	messageId: string;
	character: CharacterDisplay | undefined;
}) {
	const store = useCompanionStore();
	const labels = () => props.character?.character.work_presentation?.labels;

	const commissions = () =>
		store.commission
			.commissions()
			.filter(
				(item) =>
					item.triggerMessageId === props.messageId &&
					(!item.conversationId || item.conversationId === store.activeConversationId),
			);
	const runsFor = (commissionId: string) =>
		store.runs.filter((run) => run.commissionId === commissionId);

	return (
		<Show when={commissions().length > 0}>
			<div class="work-action-line" data-message-id={props.messageId}>
				<For each={commissions()}>
					{(commission) => (
						<>
							<Show when={commission.status === "draft" || commission.status === "approved"}>
								<WorkProposalCard commission={commission} labels={labels()} />
							</Show>
							<For each={runsFor(commission.id)}>
								{(run) => (
									<WorkRunCard
										commission={commission}
										run={run}
										messageId={props.messageId}
										labels={labels()}
									/>
								)}
							</For>
						</>
					)}
				</For>
			</div>
		</Show>
	);
}
