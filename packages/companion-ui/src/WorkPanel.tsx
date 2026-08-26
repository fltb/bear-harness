import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { createMemo, For, Show } from "solid-js";
import type { CharacterDisplay } from "./stores/companion.js";
import type { RunInfo, RunPermissionRequest } from "./stores/ipc.js";
import { useShellWorkflowStore } from "./stores/shell-workflows.js";

type WorkLabels = NonNullable<CharacterDisplay["character"]["work_presentation"]>["labels"];
const active = (status: RunInfo["status"]) =>
	status === "enqueued" || status === "running" || status === "needs_user";
export function PermissionCard(props: { permission: RunPermissionRequest }) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = useShellWorkflowStore();
	const key = `${props.permission.runId}:${props.permission.requestId}`;
	const state = workflow.permissionAction(key);
	const act = (action: () => Promise<unknown>) => workflow.runPermissionAction(key, action);
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
							{option.kind.includes("reject")
								? t("work.timeline.permissionDeny")
								: t("work.timeline.permissionAllow")}
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
	const permissions = workflow.permissionsForRun(props.run.id);
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
		<div
			class="action-proposal run-controls"
			data-run-id={props.run.id}
			data-run-status={props.run.status}
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
			<For each={permissions()}>{(permission) => <PermissionCard permission={permission} />}</For>
		</div>
	);
}
export function WorkTimelineItem(props: { messageId: string }) {
	const workflow = useShellWorkflowStore();
	const labels = createMemo(() => workflow.character()?.character.work_presentation?.labels);
	const runs = workflow.runsForMessage(props.messageId);
	return (
		<Show when={runs().length}>
			<div class="work-action-line" data-message-id={props.messageId}>
				<For each={runs()}>{(run) => <WorkRunCard run={run} labels={labels()} />}</For>
			</div>
		</Show>
	);
}
