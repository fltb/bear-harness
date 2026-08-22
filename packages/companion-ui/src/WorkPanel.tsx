import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { createMemo, For, Show } from "solid-js";
import { useResultSpace } from "./features/ResultSpace.js";
import { type CharacterDisplay, useCompanionStore } from "./stores/companion.js";
import { useShellWorkflowStore } from "./stores/shell-workflows.js";
import type { Commission, RunInfo, RunPermissionRequest } from "./stores/ipc.js";

type WorkLabels = NonNullable<CharacterDisplay["character"]["work_presentation"]>["labels"];
const steerable = (status: RunInfo["status"]) => status === "running" || status === "needs_user";
const interruptible = (status: RunInfo["status"]) => status === "enqueued" || status === "running" || status === "needs_user";
const isFailure = (status: RunInfo["status"]) => status === "failed" || status === "cancelled" || status === "forced_termination";
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function useOptionalResultSpace() {
	try {
		return useResultSpace();
	} catch {
		return undefined;
	}
}

export function WorkProposalCard(props: { commission: Commission; labels?: WorkLabels }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const actionState = workflow.commissionAction(props.commission.id);
	const start = () =>
		void workflow.runCommissionAction(props.commission.id, async () => {
			if (props.commission.status === "draft") await workflow.host.commission.approve(props.commission.id, props.commission.draft.hash);
			await workflow.host.commission.launch(props.commission.id, "pi-product-managed");
		});
	const reject = () => void workflow.runCommissionAction(props.commission.id, () => workflow.host.commission.reject(props.commission.id));
	return (
		<div class="action-proposal" data-commission-id={props.commission.id}>
			<div><span class="system-label">{props.labels?.proposal ?? t("work.timeline.proposal")}</span><h3>{props.commission.draft.title}</h3><p>{props.commission.draft.description}</p></div>
			<Show when={actionState.error()}>{(error) => <span class="status-line error" role="alert">{t("messages.operationFailedPrefix")}{error()}</span>}</Show>
			<div class="scope-list">
				<Show when={props.commission.draft.reads.length > 0}><p><strong>{t("work.reads")}</strong>{props.commission.draft.reads.join("、")}</p></Show>
				<Show when={props.commission.draft.writes.length > 0}><p><strong>{t("work.writes")}</strong>{props.commission.draft.writes.join("、")}</p></Show>
				<p><strong>{t("work.network")}</strong>{props.commission.draft.networkAllowed ? t("work.networkYes") : t("work.networkNo")}</p>
			</div>
			<div class="work-actions"><Button data-control="command" type="button" disabled={actionState.busy()} onClick={start}>{props.labels?.approve ?? t("work.timeline.start")}</Button><Button data-control="command" type="button" disabled={actionState.busy()} onClick={reject}>{props.labels?.reject ?? t("work.timeline.cancel")}</Button></div>
		</div>
	);
}

export function PermissionCard(props: { permission: RunPermissionRequest }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const actionId = `${props.permission.runId}:${props.permission.requestId}`;
	const actionState = workflow.permissionAction(actionId);
	const runAction = (action: () => Promise<unknown>) => workflow.runPermissionAction(actionId, action);
	return (
		<div class="action-proposal needs-user" data-permission-request={props.permission.requestId}>
			<span class="system-label">{t("work.timeline.needsYou")}</span><h3>{props.permission.prompt}</h3>
			<Show when={actionState.error()}>{(error) => <span class="status-line error" role="alert">{t("messages.operationFailedPrefix")}{error()}</span>}</Show>
			<div class="work-actions">
				<For each={props.permission.options}>{(option) => <Button data-control="command" type="button" disabled={actionState.busy()} onClick={() => runAction(() => workflow.host.run.respondPermission(props.permission.runId, props.permission.requestId, option.optionId))}>{option.kind.includes("reject") ? t("work.timeline.permissionDeny") : t("work.timeline.permissionAllow")}</Button>}</For>
				<Button data-control="command" type="button" disabled={actionState.busy()} onClick={() => runAction(() => workflow.host.run.cancel(props.permission.runId))}>{t("work.timeline.stopRun")}</Button>
			</div>
		</div>
	);
}

export function WorkRunCard(props: { commission: Commission; run: RunInfo; messageId: string; labels?: WorkLabels }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const actionState = workflow.runActionState(props.run.id);
	const resultSpace = useOptionalResultSpace();
	const runArtifacts = workflow.artifactsForRun(props.run.id);
	const runPermissions = workflow.permissionsForRun(props.run.id);
	const conversationId = createMemo(() => props.commission.conversationId ?? workflow.host.activeConversationId ?? "");
	const statusLabel = createMemo(() => {
		switch (props.run.status) {
			case "running": return props.labels?.running ?? t("work.timeline.runStatuses.running");
			case "needs_user": return props.labels?.needs_user ?? t("work.timeline.runStatuses.needs_user");
			case "interrupted": return props.labels?.interrupted ?? t("work.timeline.runStatuses.interrupted");
			case "completed": return props.labels?.completed ?? t("work.timeline.completed");
			case "failed": case "cancelled": case "forced_termination": return props.labels?.failed ?? t("work.timeline.failed");
			default: return t(`work.timeline.runStatuses.${props.run.status}`) ?? t("threadHead.statusUpdating");
		}
	});
	const resultSelection = createMemo(() => resultSpace?.selection());
	const isResultOpen = createMemo(() => resultSelection()?.runId === props.run.id);
	const submitSteer = async () => {
		const instruction = actionState.steerText().trim();
		if (!instruction || actionState.busy()) return;
		if (await workflow.runRunAction(props.run.id, () => workflow.host.run.steer(props.run.id, instruction))) actionState.setSteerText("");
	};
	const openResults = (event: MouseEvent) => {
		const first = runArtifacts()[0];
		if (!first || !resultSpace) return;
		resultSpace.open({ conversationId: conversationId(), triggerMessageId: props.messageId, commissionId: props.commission.id, runId: props.run.id, artifactId: first.id }, event.currentTarget as HTMLButtonElement);
	};
	return (
		<div class="action-proposal run-controls" data-run-status={props.run.status} data-result-open={isResultOpen() ? "" : undefined}>
			<span class="system-label">{statusLabel()}</span><h3>{props.commission.draft.title}</h3>
			<Show when={actionState.error()}>{(error) => <span class="status-line error" role="alert">{t("messages.operationFailedPrefix")}{error()}</span>}</Show>
			<Show when={steerable(props.run.status)}><div class="steer-row"><TextField><TextField.Input type="text" class="steer-input" aria-label={t("work.steerInputLabel")} placeholder={props.labels?.steer_placeholder ?? t("work.timeline.steerPlaceholder")} value={actionState.steerText()} onInput={(event) => actionState.setSteerText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitSteer(); } }} /></TextField><Button data-control="command" type="button" disabled={actionState.busy() || !actionState.steerText().trim()} onClick={() => void submitSteer()}>{t("work.timeline.steer")}</Button></div></Show>
			<Show when={interruptible(props.run.status) || props.run.status === "interrupted"}><div class="work-actions"><Show when={interruptible(props.run.status)}><Button data-control="command" type="button" disabled={actionState.busy()} onClick={() => void workflow.runRunAction(props.run.id, () => workflow.host.run.interrupt(props.run.id))}>{props.labels?.interrupt ?? t("work.timeline.interrupt")}</Button></Show><Show when={props.run.status === "interrupted"}><Button data-control="command" type="button" disabled={actionState.busy()} onClick={() => void workflow.runRunAction(props.run.id, () => workflow.host.run.resume(props.run.id))}>{props.labels?.resume ?? t("work.timeline.resume")}</Button></Show></div></Show>
			<For each={runPermissions()}>{(permission) => <PermissionCard permission={permission} />}</For>
			<Show when={props.run.status === "completed" && runArtifacts().length > 0}><div class="completion-card"><span class="system-label">{props.labels?.completed ?? t("work.timeline.completed")}</span><p class="completion-count">{t("work.timeline.resultCount").replace("{count}", String(runArtifacts().length))}</p><div class="artifact-list"><For each={runArtifacts()}>{(artifact) => <div class="artifact-row"><div><strong>{artifact.logicalName}</strong><span>{formatBytes(artifact.bytes)} · {t(`work.artifactStatuses.${artifact.status}`)}</span></div><Button data-control="command" type="button" onClick={() => void workflow.host.artifact.download(artifact.id)}>{t("work.download")}</Button></div>}</For></div><div class="work-actions"><Button data-control="command" type="button" class="primary-tool" onClick={openResults}>{props.labels?.artifact_open ?? t("work.timeline.viewArtifacts")}</Button></div></div></Show>
			<Show when={isFailure(props.run.status)}><div class="failure-card"><span class="system-label">{props.labels?.failed ?? t("work.timeline.failed")}</span><p>{t(`work.timeline.runStatuses.${props.run.status}`)}</p></div></Show>
			<Show when={runArtifacts().length > 0}><details class="tool-trace"><summary>{props.labels?.artifact_reveal ?? t("work.timeline.revealDetails")}</summary><ul><For each={runArtifacts()}>{(artifact) => <li data-status={artifact.status}><strong>{artifact.logicalName}</strong><span>{formatBytes(artifact.bytes)} · {t(`work.artifactStatuses.${artifact.status}`)}</span><Button data-control="command" type="button" onClick={() => void workflow.host.artifact.download(artifact.id)}>{t("work.download")}</Button></li>}</For></ul></details></Show>
		</div>
	);
}

export function WorkTimelineItem(props: { messageId: string; character: CharacterDisplay | undefined }) {
	const workflow = useShellWorkflowStore();
	const labels = createMemo(() => props.character?.character.work_presentation?.labels);
	const messageCommissions = workflow.commissionsForMessage(props.messageId);
	return <Show when={messageCommissions().length > 0}><div class="work-action-line" data-message-id={props.messageId}><For each={messageCommissions()}>{(commission) => <><Show when={commission.status === "draft" || commission.status === "approved"}><WorkProposalCard commission={commission} labels={labels()} /></Show><For each={workflow.runsForCommission(commission.id)()}>{(run) => <WorkRunCard commission={commission} run={run} messageId={props.messageId} labels={labels()} />}</For></>}</For></div></Show>;
}
