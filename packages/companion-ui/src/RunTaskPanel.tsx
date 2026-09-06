import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { RunInfo } from "./stores/ipc.js";
import { useShellWorkflowStore } from "./stores/shell-workflows.js";
import { Button, TextField } from "./ui/primitives.js";
import { PermissionCard, WorkRunCard } from "./WorkPanel.js";

export function RunTaskPanel(props: { onBack?: () => void }) {
	const workflow = useShellWorkflowStore();
	const [t] = useTranslation(undefined, { i18n });
	const [historyOpen, setHistoryOpen] = createSignal(false);
	const recent = createMemo(() =>
		workflow.host.runs.filter(
			(run) =>
				run.status !== "enqueued" &&
				run.status !== "running" &&
				run.status !== "needs_user" &&
				run.status !== "interrupted",
		),
	);
	return (
		<div class="task-panel">
			<p class="task-scope">{t("work.task.scope")}</p>
			<Show
				when={workflow.selectedTaskId()}
				keyed
				fallback={
					<>
						<h3>{t("work.task.unfinished")}</h3>
						<Show
							when={workflow.activeRuns().length}
							fallback={<p class="empty">{t("threadHead.noRunningWork")}</p>}
						>
							<For each={workflow.activeRuns()}>{(run) => <WorkRunCard run={run} />}</For>
						</Show>
						<Show when={!historyOpen() && recent().length}>
							<h3>{t("threadHead.recentWork")}</h3>
							<For each={recent()}>{(run) => <WorkRunCard run={run} />}</For>
						</Show>
						<Button
							type="button"
							class="task-inspect"
							aria-expanded={historyOpen()}
							onClick={() => setHistoryOpen((open) => !open)}
						>
							{t("work.task.history")}
						</Button>
						<Show when={historyOpen()}>
							<TaskHistory />
						</Show>
					</>
				}
			>
				{(runId) => <TaskDetails runId={runId} onBack={props.onBack} />}
			</Show>
		</div>
	);
}

function TaskHistory() {
	const workflow = useShellWorkflowStore();
	const [t] = useTranslation(undefined, { i18n });
	const pagination = createMemo(() => {
		workflow.character()?.id;
		const [pages, setPages] = createSignal<(string | undefined)[]>([undefined]);
		return { pages, setPages };
	});
	const history = workflow.host.run.observeHistory(() => pagination().pages().at(-1));
	return (
		<section
			aria-label={t("work.task.history")}
			aria-busy={history.isFetching}
			class="task-history"
		>
			<Show when={history.isPending}>
				<p role="status">{t("work.task.loading")}</p>
			</Show>
			<Show when={history.error}>
				{(error) => (
					<p role="alert">
						{t("work.task.loadFailed")}: {error().message}
					</p>
				)}
			</Show>
			<Show when={history.isError}>
				<Button type="button" disabled={history.isFetching} onClick={() => void history.refetch()}>
					{t("work.task.retry")}
				</Button>
			</Show>
			<Show when={history.isSuccess && !history.data?.runs.length}>
				<p>{t("work.task.noHistory")}</p>
			</Show>
			<For each={history.data?.runs}>{(run) => <WorkRunCard run={run} />}</For>
			<div class="task-pagination">
				<Show when={pagination().pages().length > 1}>
					<Button
						type="button"
						disabled={history.isFetching}
						onClick={() => pagination().setPages((value) => value.slice(0, -1))}
					>
						{t("work.task.previousPage")}
					</Button>
				</Show>
				<Show when={history.data?.nextCursor}>
					{(cursor) => (
						<Button
							type="button"
							disabled={history.isFetching}
							onClick={() => pagination().setPages((value) => [...value.slice(-99), cursor()])}
						>
							{t("work.task.loadOlder")}
						</Button>
					)}
				</Show>
			</div>
		</section>
	);
}

function TaskDetails(props: { runId: string; onBack?: () => void }) {
	const workflow = useShellWorkflowStore();
	const [t] = useTranslation(undefined, { i18n });
	const [pages, setPages] = createSignal<(string | undefined)[]>([undefined]);
	const detail = workflow.host.run.observeDetail(
		() => props.runId,
		() => pages().at(-1),
	);
	const navigation = workflow.runActionState(`${props.runId}:origin`);
	return (
		<section
			ref={(element) => {
				onMount(() => {
					if (element.isConnected) element.focus();
				});
			}}
			tabIndex={-1}
			class="task-details"
			data-task-detail={props.runId}
			aria-label={t("work.task.details")}
			aria-busy={detail.isFetching}
		>
			<Button
				type="button"
				class="task-inspect"
				onClick={() => {
					workflow.closeTask();
					props.onBack?.();
				}}
			>
				{t("work.task.back")}
			</Button>
			<Show when={detail.isPending}>
				<p role="status">{t("work.task.loading")}</p>
			</Show>
			<Show when={detail.error}>
				{(error) => (
					<p role="alert">
						{t("work.task.loadFailed")}: {error().message}
					</p>
				)}
			</Show>
			<Show when={detail.isError}>
				<Button type="button" disabled={detail.isFetching} onClick={() => void detail.refetch()}>
					{t("work.task.retry")}
				</Button>
			</Show>
			<Show when={detail.data}>
				{(data) => {
					const run = () => data().run;
					const terminal = () =>
						run().status === "completed" ||
						run().status === "failed" ||
						run().status === "cancelled" ||
						run().status === "forced_termination";
					const activity = createMemo(() => {
						const times = [
							run().startedAt,
							run().completedAt,
							...run().evidence.map((item) => item.createdAt),
						].filter((value): value is string => !!value);
						return times.sort().at(-1);
					});
					return (
						<>
							<WorkRunCard run={run()} />
							<dl class="task-metadata">
								<dt>{t("work.result.producerRun")}</dt>
								<dd>{run().id}</dd>
								<dt>{t("work.result.executorProfile")}</dt>
								<dd>{run().executorProfile}</dd>
								<dt>{t("work.result.triggerEntry")}</dt>
								<dd>{run().triggerEntryId}</dd>
								<Show when={activity()}>
									{(at) => (
										<>
											<dt>{t("work.task.lastActivity")}</dt>
											<dd>
												<time dateTime={at()}>{new Date(at()).toLocaleString()}</time>
											</dd>
										</>
									)}
								</Show>
							</dl>
							<Button
								type="button"
								class="task-inspect"
								disabled={navigation.busy()}
								onClick={() =>
									void workflow.runRunAction(`${props.runId}:origin`, () =>
										workflow.host.selectConversation(run().conversationId),
									)
								}
							>
								{t("work.task.openOrigin")}
							</Button>
							<Show when={navigation.error()}>{(error) => <p role="alert">{error()}</p>}</Show>
							<Show when={navigation.busy()}>
								<p role="status">{t("work.task.busy")}</p>
							</Show>
							<Show when={terminal()}>
								<p class="task-notice">{t("work.task.completionNotice")}</p>
								<p class="task-notice" role="status">
									{run().resultReportedAt
										? t("work.task.delivered")
										: t("work.task.deliveryPending")}
								</p>
							</Show>
							<Show when={!terminal() && run().controller !== "attached"}>
								<p class="task-notice">
									{run().controller === "confirmed_lost"
										? t("work.task.controllerLost")
										: t("work.task.controllerUnknown")}
								</p>
							</Show>
							<RunControls run={run()} />
							<Show when={run().permission} keyed>
								{(permission) => <PermissionCard permission={permission} run={run()} />}
							</Show>
							<details class="task-disclosure">
								<summary>{t("work.task.instruction")}</summary>
								<pre>{data().instruction}</pre>
								<Show when={data().inputPaths.length}>
									<h4>{t("work.task.inputs")}</h4>
									<ul>
										<For each={data().inputPaths}>
											{(path) => (
												<li>
													<code>{path}</code>
												</li>
											)}
										</For>
									</ul>
								</Show>
							</details>
							<Show when={run().summary}>
								{(summary) => (
									<section>
										<h4>
											{run().status === "failed" ? t("work.task.errors") : t("work.result.summary")}
										</h4>
										<pre>{summary()}</pre>
									</section>
								)}
							</Show>
							<Show when={!run().artifacts.length}>
								<p class="task-notice">{t("work.task.noArtifacts")}</p>
							</Show>
							<section class="task-evidence" aria-label={t("work.result.evidence")}>
								<h4>{t("work.result.evidence")}</h4>
								<Show when={data().evidence.length} fallback={<p>{t("work.result.noEvidence")}</p>}>
									<For each={data().evidence}>
										{(item) => (
											<details class="task-disclosure" data-evidence-id={item.id}>
												<summary>
													{item.kind} ·{" "}
													<time dateTime={item.createdAt}>
														{new Date(item.createdAt).toLocaleString()}
													</time>
												</summary>
												<pre>{JSON.stringify(item.data, null, 2)}</pre>
											</details>
										)}
									</For>
								</Show>
								<div class="task-pagination">
									<Show when={pages().length > 1}>
										<Button
											type="button"
											disabled={detail.isFetching}
											onClick={() => setPages((value) => value.slice(0, -1))}
										>
											{t("work.task.previousPage")}
										</Button>
									</Show>
									<Show when={data().nextCursor}>
										{(cursor) => (
											<Button
												type="button"
												disabled={detail.isFetching}
												onClick={() => setPages((value) => [...value.slice(-99), cursor()])}
											>
												{t("work.task.olderEvidence")}
											</Button>
										)}
									</Show>
								</div>
							</section>
						</>
					);
				}}
			</Show>
		</section>
	);
}

function RunControls(props: { run: RunInfo }) {
	const workflow = useShellWorkflowStore();
	const [t] = useTranslation(undefined, { i18n });
	const draft = workflow.runActionState(props.run.id);
	const actions = [
		"steer",
		"interrupt",
		"resume",
		"cancel",
		"retryDelivery",
		"requestAgain",
	] as const;
	const states = actions.map((action) => ({
		action,
		state: workflow.runActionState(`${props.run.id}:${action}`),
	}));
	const busy = createMemo(() => states.some(({ state }) => state.busy()));
	const [receipt, setReceipt] = createSignal<
		"injected" | "startedNewTurn" | "sent" | "requestAgain"
	>();
	const execute = async (action: (typeof actions)[number]) => {
		if (busy()) return;
		const instruction = draft.steerText().trim();
		setReceipt(undefined);
		let nextReceipt: "injected" | "startedNewTurn" | "sent" | "requestAgain" | undefined;
		const succeeded = await workflow.runRunAction(`${props.run.id}:${action}`, async () => {
			switch (action) {
				case "steer": {
					const result = await workflow.host.run.steer(props.run.id, instruction);
					nextReceipt = result.outcome;
					break;
				}
				case "resume":
					await workflow.host.run.resume(props.run.id, instruction || undefined);
					break;
				case "interrupt":
					await workflow.host.run.interrupt(props.run.id);
					break;
				case "cancel":
					await workflow.host.run.cancel(props.run.id);
					break;
				case "retryDelivery":
					await workflow.host.run.retryDelivery(props.run.id);
					break;
				case "requestAgain":
					await workflow.requestRunAgain(
						props.run,
						t("work.task.requestAgainMessage", { runId: props.run.id, instruction }),
					);
					nextReceipt = "requestAgain";
					break;
			}
		});
		if (succeeded) setReceipt(nextReceipt);
		if (
			succeeded &&
			(action === "steer" || action === "resume" || action === "requestAgain") &&
			draft.steerText().trim() === instruction
		)
			draft.setSteerText("");
	};
	const canRequestAgain = createMemo(
		() =>
			props.run.status === "completed" ||
			props.run.status === "failed" ||
			props.run.status === "cancelled" ||
			props.run.status === "forced_termination" ||
			props.run.controller === "confirmed_lost",
	);
	return (
		<div class="task-controls" aria-busy={busy()}>
			<Show
				when={
					props.run.actions?.includes("steer") ||
					props.run.actions?.includes("resume") ||
					canRequestAgain()
				}
			>
				<TextField>
					<TextField.Label>{t("work.steerInputLabel")}</TextField.Label>
					<TextField.TextArea
						class="task-instruction"
						value={draft.steerText()}
						maxLength={12000}
						onInput={(event) => draft.setSteerText(event.currentTarget.value)}
					/>
				</TextField>
			</Show>
			<div class="work-actions">
				<Show when={props.run.actions?.includes("steer")}>
					<Button
						type="button"
						disabled={busy() || !draft.steerText().trim()}
						onClick={() => void execute("steer")}
					>
						{t("work.timeline.steer")}
					</Button>
				</Show>
				<Show when={props.run.actions?.includes("interrupt")}>
					<Button type="button" disabled={busy()} onClick={() => void execute("interrupt")}>
						{t("work.timeline.interrupt")}
					</Button>
				</Show>
				<Show when={props.run.actions?.includes("resume")}>
					<Button type="button" disabled={busy()} onClick={() => void execute("resume")}>
						{t("work.timeline.resume")}
					</Button>
				</Show>
				<Show when={props.run.actions?.includes("cancel")}>
					<Button type="button" disabled={busy()} onClick={() => void execute("cancel")}>
						{t("work.timeline.stopRun")}
					</Button>
				</Show>
				<Show when={props.run.actions?.includes("retryDelivery")}>
					<Button type="button" disabled={busy()} onClick={() => void execute("retryDelivery")}>
						{t("work.task.retryDelivery")}
					</Button>
				</Show>
				<Show when={canRequestAgain()}>
					<Button type="button" disabled={busy()} onClick={() => void execute("requestAgain")}>
						{t("work.task.requestAgain")}
					</Button>
				</Show>
			</div>
			<Show when={!props.run.actions?.length}>
				<p class="task-notice">{t("work.task.noActions")}</p>
			</Show>
			<Show when={busy()}>
				<p role="status">{t("work.task.busy")}</p>
			</Show>
			<Show when={receipt()}>
				{(outcome) => (
					<p role="status">
						{outcome() === "requestAgain"
							? t("work.task.requestSent")
							: t(`work.task.steerOutcomes.${outcome() as "injected" | "startedNewTurn" | "sent"}`)}
					</p>
				)}
			</Show>
			<For each={states}>
				{({ state }) => (
					<Show when={state.error()}>{(error) => <p role="alert">{error()}</p>}</Show>
				)}
			</For>
		</div>
	);
}
