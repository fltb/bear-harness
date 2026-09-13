import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, createSignal, For, Show } from "solid-js";
import { NativeMessageContent } from "./NativeMessageContent.js";
import type { RunGetResponse, RunInfo } from "./stores/ipc.js";

type Evidence = RunGetResponse["evidence"][number];
type EventStatus = NonNullable<RunInfo["evidence"][number]["status"]>;
export type RunEvent = {
	id: string;
	kind: string;
	title?: string;
	status?: EventStatus;
	createdAt: string;
	updatedAt: string;
	input: string;
	output: string;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	success?: boolean;
	records: Evidence[];
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	const content = record(value).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = record(part);
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** The endpoint supplies newest-first insertion order, not lexicographic UUID order. */
export function projectRunEvents(evidence: readonly Evidence[]): RunEvent[] {
	const events: RunEvent[] = [];
	const tools = new Map<string, RunEvent>();
	for (let index = evidence.length - 1; index >= 0; index--) {
		const item = evidence[index];
		if (!item) continue;
		const data = record(item.data);
		if (item.kind === "acp.tool_call" || item.kind === "acp.tool_call_update") {
			const toolId = typeof data.toolCallId === "string" ? data.toolCallId : item.id;
			let event = tools.get(toolId);
			if (!event) {
				event = {
					id: `tool:${toolId}`,
					kind: "tool",
					createdAt: item.createdAt,
					updatedAt: item.createdAt,
					input: "",
					output: "",
					records: [],
				};
				tools.set(toolId, event);
				events.push(event);
			}
			if (typeof data.title === "string" && data.title) event.title = data.title;
			const input = record(data.rawInput);
			if (typeof input.command === "string") event.input = input.command;
			else if (typeof input.path === "string") event.input = input.path;
			const output = text(data.rawOutput) || text({ content: data.content });
			if (output) event.output = output;
			if (["pending", "in_progress", "completed", "failed"].includes(String(data.status)))
				event.status = data.status as EventStatus;
			event.updatedAt = item.createdAt;
			event.records.push(item);
			continue;
		}
		const last = events.at(-1);
		if (
			item.kind === "acp.message" &&
			evidence[index + 1]?.kind === item.kind &&
			last?.kind === item.kind
		) {
			last.output += text(data.text);
			last.updatedAt = item.createdAt;
			last.records.push(item);
			continue;
		}
		events.push({
			id: item.id,
			kind: item.kind,
			createdAt: item.createdAt,
			updatedAt: item.createdAt,
			input: "",
			output:
				text(data.text) ||
				text(data.message) ||
				text(data.errorMessage) ||
				text(data.finalError) ||
				text(data.reason),
			...(typeof data.attempt === "number" ? { attempt: data.attempt } : {}),
			...(typeof data.maxAttempts === "number" ? { maxAttempts: data.maxAttempts } : {}),
			...(typeof data.delayMs === "number" ? { delayMs: data.delayMs } : {}),
			...(typeof data.success === "boolean" ? { success: data.success } : {}),
			records: [item],
		});
	}
	return events;
}

function eventLabel(kind: string, title?: string) {
	if (kind === "tool" || kind === "acp.tool_call" || kind === "acp.tool_call_update") {
		if (title === "bash") return "work.activity.command" as const;
		if (title === "read") return "work.activity.read" as const;
		if (title === "write" || title === "edit") return "work.activity.write" as const;
		return "work.activity.tool" as const;
	}
	if (kind === "pi.turn_start") return "work.activity.model" as const;
	if (kind === "pi.auto_retry_start") return "work.activity.retry" as const;
	if (kind === "pi.auto_retry_end") return "work.activity.retryEnd" as const;
	if (kind === "acp.message") return "work.activity.message" as const;
	if (kind === "acp.error" || kind === "executor.launch_failed" || kind === "executor.failed")
		return "work.activity.error" as const;
	if (kind === "run.paused") return "work.activity.paused" as const;
	return "work.activity.event" as const;
}

export function runEventTime(value: string): Date {
	return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

export function RunActivity(props: { run: RunInfo }) {
	const [t] = useTranslation(undefined, { i18n });
	const latest = createMemo(() => props.run.evidence.at(-1));
	const terminal = () =>
		["completed", "failed", "cancelled", "forced_termination"].includes(props.run.status);
	return (
		<div class="task-activity" aria-live="polite" aria-atomic="true">
			<Show when={!terminal()}>
				<p class="task-activity-label">
					<span class="task-activity-dot" aria-hidden="true" />
					{props.run.status !== "running"
						? t(`work.timeline.runStatuses.${props.run.status}`)
						: latest()
							? t(eventLabel(latest()?.kind ?? "", latest()?.title))
							: t("work.activity.starting")}
					<Show when={props.run.status === "running" && latest()?.status}>
						{(status) => <span>{t(`work.activity.status.${status()}`)}</span>}
					</Show>
				</p>
				<Show when={latest()?.summary}>
					{(summary) => <p class="task-activity-preview">{summary()}</p>}
				</Show>
			</Show>
			<Show when={props.run.completedAt || latest()?.createdAt || props.run.startedAt}>
				{(at) => (
					<small class="task-activity-time">
						{terminal() ? t("work.activity.finishedAt") : t("work.activity.updatedAt")}{" "}
						<time dateTime={at()}>{runEventTime(at()).toLocaleTimeString()}</time>
					</small>
				)}
			</Show>
		</div>
	);
}

export function RunEventTimeline(props: { evidence: readonly Evidence[] }) {
	const [t] = useTranslation(undefined, { i18n });
	const projection = createMemo(() => {
		const events = projectRunEvents(props.evidence);
		return {
			ids: events.map((event) => event.id),
			byId: new Map(events.map((event) => [event.id, event])),
		};
	});
	return (
		<ol class="task-event-timeline" aria-label={t("work.activity.timeline")}>
			<For each={projection().ids}>
				{(id) => (
					<Show when={projection().byId.get(id)}>
						{(event) => <RunEventItem event={event()} />}
					</Show>
				)}
			</For>
		</ol>
	);
}

function RunEventItem(props: { event: RunEvent }) {
	const [t] = useTranslation(undefined, { i18n });
	const [rawOpen, setRawOpen] = createSignal(false);
	const warning = () =>
		props.event.status === "failed" ||
		props.event.kind === "acp.error" ||
		props.event.kind === "pi.auto_retry_start" ||
		props.event.success === false;
	return (
		<li
			class="task-event"
			data-event-kind={props.event.kind}
			data-event-status={props.event.status}
			data-event-warning={warning()}
		>
			<span class="task-event-marker" aria-hidden="true" />
			<div class="task-event-content">
				<header class="task-event-head">
					<strong>{t(eventLabel(props.event.kind, props.event.title))}</strong>
					<Show when={props.event.status}>
						{(status) => (
							<span class="task-event-state">{t(`work.activity.status.${status()}`)}</span>
						)}
					</Show>
					<time dateTime={props.event.createdAt}>
						{runEventTime(props.event.createdAt).toLocaleTimeString()}
					</time>
				</header>
				<Show when={props.event.attempt !== undefined && props.event.maxAttempts !== undefined}>
					<p class="task-notice">
						{t("work.activity.attempt", {
							attempt: props.event.attempt ?? 0,
							total: props.event.maxAttempts ?? props.event.attempt ?? 0,
						})}
						<Show when={props.event.delayMs !== undefined}>
							{" "}
							·{" "}
							{t("work.activity.retryDelay", {
								seconds: Math.ceil((props.event.delayMs ?? 0) / 1000),
							})}
						</Show>
					</p>
				</Show>
				<Show when={props.event.success !== undefined}>
					<p class="task-notice">
						{props.event.success ? t("work.activity.recovered") : t("work.activity.retryFailed")}
					</p>
				</Show>
				<Show when={props.event.input}>
					<pre class="task-event-command">{props.event.input}</pre>
				</Show>
				<Show when={props.event.output}>
					{(output) => (
						<div class="task-event-output">
							<NativeMessageContent content={output()} format="plain" />
						</div>
					)}
				</Show>
				<details class="task-event-raw" onToggle={(event) => setRawOpen(event.currentTarget.open)}>
					<summary>{t("work.activity.raw")}</summary>
					<Show when={rawOpen()}>
						<pre>{JSON.stringify(props.event.records, null, 2)}</pre>
					</Show>
				</details>
			</div>
		</li>
	);
}
