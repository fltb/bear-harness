import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, For, Show } from "solid-js";
import type { CharacterDisplay } from "./stores/companion.js";
import type { RunInfo, RunPermissionRequest } from "./stores/ipc.js";
import { useShellWorkflowStore } from "./stores/shell-workflows.js";
import { Button, Dialog, TextField } from "./ui/primitives.js";

type WorkLabels = NonNullable<CharacterDisplay["character"]["work_presentation"]>["labels"];
const active = (status: RunInfo["status"]) =>
	status === "enqueued" || status === "running" || status === "needs_user";
export function PermissionCard(props: { permission: RunPermissionRequest }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const key = `${props.permission.runId}:${props.permission.requestId}`;
	const state = workflow.permissionAction(key);
	const act = (action: () => Promise<unknown>) => workflow.runPermissionAction(key, action);
	const optionLabel = (option: RunPermissionRequest["options"][number]) => {
		if (option.kind.includes("reject")) return t("work.timeline.permissionDeny");
		if (option.optionId === "accept_execpolicy_amendment")
			return t("work.timeline.permissionAllowCommand");
		if (option.kind === "allow_always") return t("work.timeline.permissionAllowSession");
		return t("work.timeline.permissionAllow");
	};
	return (
		<div class="action-proposal needs-user" data-permission-request={props.permission.requestId}>
			<span class="system-label">{t("work.timeline.needsYou")}</span>
			<h3>{props.permission.prompt}</h3>
			<Show when={state.error()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<div class="work-actions">
				<For each={props.permission.options}>
					{(option) => (
						<Button
							type="button"
							disabled={state.busy()}
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
							{optionLabel(option)}
						</Button>
					)}
				</For>
				<Button
					type="button"
					disabled={state.busy()}
					onClick={() => act(() => workflow.host.run.cancel(props.permission.runId))}
				>
					{t("work.timeline.stopRun")}
				</Button>
			</div>
		</div>
	);
}
export function WorkRunCard(props: { run: RunInfo; labels?: WorkLabels }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const state = workflow.runActionState(props.run.id);
	const label = createMemo(() =>
		props.run.status === "completed"
			? (props.labels?.completed ?? t("work.timeline.completed"))
			: props.run.status === "failed" ||
					props.run.status === "cancelled" ||
					props.run.status === "forced_termination"
				? (props.labels?.failed ?? t("work.timeline.failed"))
				: t(`work.timeline.runStatuses.${props.run.status}`),
	);
	const steer = async () => {
		const text = state.steerText().trim();
		if (
			text &&
			(await workflow.runRunAction(props.run.id, () => workflow.host.run.steer(props.run.id, text)))
		)
			state.setSteerText("");
	};
	return (
		<article
			class="action-proposal run-controls"
			data-run-id={props.run.id}
			data-run-status={props.run.status}
			aria-label={`${label()} · ${props.run.title}`}
		>
			<span class="system-label">{label()}</span>
			<h3>{props.run.title}</h3>
			<Show when={state.error()}>{(error) => <span role="alert">{error()}</span>}</Show>
			<Show when={props.run.status === "running" || props.run.status === "needs_user"}>
				<div class="steer-row">
					<TextField>
						<TextField.Input
							class="steer-input"
							aria-label={t("work.steerInputLabel")}
							value={state.steerText()}
							onInput={(event) => state.setSteerText(event.currentTarget.value)}
						/>
					</TextField>
					<Button type="button" onClick={() => void steer()}>
						{t("work.timeline.steer")}
					</Button>
				</div>
			</Show>
			<Show when={active(props.run.status)}>
				<Button
					type="button"
					onClick={() =>
						void workflow.runRunAction(props.run.id, () =>
							workflow.host.run.interrupt(props.run.id),
						)
					}
				>
					{t("work.timeline.interrupt")}
				</Button>
			</Show>
			<Show when={props.run.status === "interrupted"}>
				<Button
					type="button"
					onClick={() =>
						void workflow.runRunAction(props.run.id, () => workflow.host.run.resume(props.run.id))
					}
				>
					{t("work.timeline.resume")}
				</Button>
			</Show>
		</article>
	);
}
export function WorkTimelineItem(props: { messageId: string }) {
	const workflow = useShellWorkflowStore();
	const runs = workflow.runsForMessage(props.messageId);
	const labels = createMemo(() => workflow.character()?.character.work_presentation?.labels);
	return (
		<Show when={runs().length}>
			<div class="work-action-line" data-message-id={props.messageId}>
				<For each={runs()}>{(run) => <WorkRunCard run={run} labels={labels()} />}</For>
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
				.filter((run) => run.conversationId === workflow.host.activeConversationId)
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
