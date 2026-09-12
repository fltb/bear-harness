import { i18n, useTranslation } from "@bear-harness/i18n";
import { type ComponentProps, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { downloadBlob } from "../lib/browser-download.js";
import { unwrap } from "../lib/ipc.js";
import { useCompanionStore } from "../stores/companion.js";
import { Button as CommandButton, TextField } from "../ui/primitives.js";

function Button(props: ComponentProps<typeof CommandButton>) {
	return <CommandButton data-control="command" {...props} />;
}

export function DiagnosticsSettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [before, setBefore] = createSignal<string>();
	const [eventFilter, setEventFilter] = createSignal("");
	const [conversationFilter, setConversationFilter] = createSignal("");
	const [incidents, setIncidents] = createSignal(false);
	const [settings, { refetch }] = createResource(
		() => store.character?.id,
		async () => unwrap(await store.diagnostics.get({})),
	);
	const [traces, { refetch: refreshTraces }] = createResource(
		() => ({
			owner: store.character?.id,
			before: before(),
			event: eventFilter(),
			conversationId: conversationFilter(),
			incidents: incidents(),
		}),
		async (query) => ({
			owner: query.owner,
			...unwrap(
				await store.diagnostics.list({
					before: query.before,
					event: query.event || undefined,
					conversationId: query.conversationId || undefined,
					incidents: query.incidents,
				}),
			),
		}),
	);
	const [error, setError] = createSignal<string>();
	const [busy, setBusy] = createSignal(false);
	const [content, setContent] = createSignal("");
	const [selected, setSelected] = createSignal("");
	const [owner, setOwner] = createSignal<string>();
	const [payload, setPayload] = createSignal("");
	const [nextEvent, setNextEvent] = createSignal<number>();
	const [pinned, setPinned] = createSignal(false);
	const visibleContent = () => (owner() === store.character?.id ? content() : "");
	const events = createMemo(() =>
		visibleContent()
			.trim()
			.split("\n")
			.filter(Boolean)
			.slice(-200)
			.map(
				(
					line,
				): {
					at: string;
					eventId?: string;
					level: string;
					event: string;
					attributes: unknown;
					payload?: { sha256: string; bytes: number };
				} => {
					try {
						const event = JSON.parse(line);
						if (
							!event ||
							typeof event.at !== "string" ||
							typeof event.event !== "string" ||
							typeof event.level !== "string"
						)
							throw new Error("invalid record");
						return event;
					} catch {
						return {
							at: "",
							level: "warn",
							event: "diagnostics.incomplete_record",
							attributes: { raw: line },
						};
					}
				},
			),
	);
	const run = async (work: () => Promise<unknown>) => {
		setBusy(true);
		setError(undefined);
		try {
			await work();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	const save = async (patch: Partial<NonNullable<ReturnType<typeof settings>>["policy"]>) => {
		const current = settings();
		if (!current) return;
		unwrap(await store.diagnostics.set({ policy: { ...current.policy, ...patch } }));
		await refetch();
	};
	const download = async () => {
		const traceId = selected();
		const characterId = store.character?.id;
		const parts: BlobPart[] = [];
		let offset: number | undefined = 0;
		let end: number | undefined;
		do {
			const page: { content: string; next?: number; end: number } = unwrap(
				await store.diagnostics.exportPage({ traceId, offset, end }),
			);
			if (characterId !== store.character?.id) return;
			parts.push(page.content, "\n");
			offset = page.next;
			end = page.end;
		} while (offset !== undefined);
		downloadBlob(new Blob(parts, { type: "application/x-ndjson" }), `trace-${traceId}.jsonl`);
	};
	return (
		<section class="settings-page-section" aria-labelledby="diagnostics-settings-title">
			<header class="settings-page-header">
				<h3 id="diagnostics-settings-title">{t("settings.diagnosticsTitle")}</h3>
				<p>{t("settings.diagnosticsHint")}</p>
			</header>
			<Show when={error() || settings.error || traces.error}>
				<p class="status-line err" role="alert">
					{error() || String(settings.error || traces.error)}
				</p>
			</Show>
			<Show when={settings()}>
				{(state) => (
					<>
						<div class="settings-fields">
							<strong>{t("settings.diagnosticsLevel")}</strong>
							<div class="diagnostics-controls">
								<For each={["trace", "debug", "info", "warn", "error", "fatal"] as const}>
									{(level) => (
										<Button
											disabled={busy()}
											aria-pressed={state().policy.level === level}
											onClick={() => void run(() => save({ level }))}
										>
											{level.toUpperCase()}
										</Button>
									)}
								</For>
							</div>
							<strong>{t("settings.diagnosticsContent")}</strong>
							<div class="diagnostics-controls">
								<For each={["full", "metadata"] as const}>
									{(payload) => (
										<Button
											disabled={busy()}
											aria-pressed={state().policy.payload === payload}
											onClick={() => void run(() => save({ payload }))}
										>
											{t(
												payload === "full"
													? "settings.diagnosticsFull"
													: "settings.diagnosticsMetadata",
											)}
										</Button>
									)}
								</For>
							</div>
							<p>
								{t("settings.diagnosticsRetention", {
									days: state().policy.maxAgeDays,
									mib: state().policy.maxBytes / 1024 / 1024,
								})}
							</p>
							<div class="diagnostics-controls">
								<For each={[7, 30, 90]}>
									{(days) => (
										<Button
											disabled={busy()}
											aria-pressed={state().policy.maxAgeDays === days}
											onClick={() => void run(() => save({ maxAgeDays: days }))}
										>
											{days} d
										</Button>
									)}
								</For>
								<For each={[50, 200, 500]}>
									{(mib) => (
										<Button
											disabled={busy()}
											aria-pressed={state().policy.maxBytes === mib * 1024 * 1024}
											onClick={() => void run(() => save({ maxBytes: mib * 1024 * 1024 }))}
										>
											{mib} MiB
										</Button>
									)}
								</For>
							</div>
							<div class="diagnostics-controls">
								<Button
									disabled={busy()}
									onClick={() => void run(() => save({ traceUntil: Date.now() + 15 * 60_000 }))}
								>
									{t("settings.diagnosticsTemporary")}
								</Button>
								<Button
									disabled={busy() || !state().policy.traceUntil}
									onClick={() => void run(() => save({ traceUntil: 0 }))}
								>
									{t("settings.diagnosticsStopTemporary")}
								</Button>
							</div>
							<Show when={state().policy.traceUntil > Date.now()}>
								<p>{new Date(state().policy.traceUntil).toLocaleString()}</p>
							</Show>
							<p role="status">
								{t("settings.diagnosticsHealth", {
									written: state().health.written,
									dropped: state().health.dropped,
									failed: state().health.writeFailures,
									queued: state().health.queued,
								})}
							</p>
						</div>
						<div class="diagnostics-controls">
							<Show when={state().canReveal}>
								<For each={["system", "character", "memory", "latest"] as const}>
									{(scope) => (
										<Button
											disabled={busy()}
											onClick={() =>
												void run(async () => unwrap(await store.diagnostics.reveal({ scope })))
											}
										>
											{t(
												scope === "latest"
													? "settings.diagnosticsRevealLatest"
													: scope === "system"
														? "settings.diagnosticsRevealSystem"
														: scope === "memory"
															? "settings.diagnosticsRevealMemory"
															: "settings.diagnosticsReveal",
											)}
										</Button>
									)}
								</For>
							</Show>
							<Button
								disabled={busy()}
								onClick={() =>
									void run(async () => {
										await refetch();
										await refreshTraces();
									})
								}
							>
								{t("settings.diagnosticsRefresh")}
							</Button>
						</div>
					</>
				)}
			</Show>
			<h4>{t("settings.diagnosticsRecent")}</h4>
			<div class="diagnostics-controls">
				<Button
					aria-pressed={incidents()}
					onClick={() => {
						setBefore(undefined);
						setIncidents(!incidents());
					}}
				>
					{t("settings.diagnosticsIncidents")}
				</Button>
			</div>
			<div class="diagnostics-controls">
				<TextField class="prompt-field" value={eventFilter()}>
					<TextField.Label>{t("settings.diagnosticsEventFilter")}</TextField.Label>
					<TextField.Input
						class="search-input"
						onChange={(event) => {
							setBefore(undefined);
							setEventFilter(event.currentTarget.value);
						}}
					/>
				</TextField>
				<TextField class="prompt-field" value={conversationFilter()}>
					<TextField.Label>{t("settings.diagnosticsConversationFilter")}</TextField.Label>
					<TextField.Input
						class="search-input"
						onChange={(event) => {
							setBefore(undefined);
							setConversationFilter(event.currentTarget.value);
						}}
					/>
				</TextField>
				<Button disabled={!before()} onClick={() => setBefore(undefined)}>
					{t("settings.diagnosticsFirstPage")}
				</Button>
				<Button disabled={!traces()?.next} onClick={() => setBefore(traces()?.next)}>
					{t("settings.diagnosticsNextPage")}
				</Button>
			</div>
			<div class="diagnostics-traces">
				<For each={traces()?.owner === store.character?.id ? traces()?.traces : []}>
					{(trace) => (
						<Button
							disabled={busy()}
							aria-pressed={owner() === store.character?.id && selected() === trace.traceId}
							aria-label={`Trace ${trace.traceId}`}
							onClick={() =>
								void run(async () => {
									const characterId = store.character?.id;
									const result = unwrap(await store.diagnostics.read({ traceId: trace.traceId }));
									if (characterId !== store.character?.id) return;
									setOwner(characterId);
									setPayload("");
									setSelected(trace.traceId);
									setContent(result.content);
									setNextEvent(result.next);
									setPinned(result.pinned);
								})
							}
						>
							{new Date(trace.modifiedAt).toLocaleString()} · {trace.traceId.slice(0, 12)}
						</Button>
					)}
				</For>
			</div>
			<Show when={visibleContent()}>
				<p>{t("settings.diagnosticsExportWarning")}</p>
				<Button disabled={busy()} onClick={() => void run(download)}>
					{t("settings.diagnosticsDownload")}
				</Button>
				<div class="diagnostics-controls">
					<Button
						disabled={busy()}
						aria-pressed={pinned()}
						onClick={() =>
							void run(async () => {
								unwrap(await store.diagnostics.pin({ traceId: selected(), pinned: true }));
								setPinned(true);
							})
						}
					>
						{t("settings.diagnosticsPin")}
					</Button>
					<Button
						disabled={busy()}
						onClick={() =>
							void run(async () => {
								unwrap(await store.diagnostics.pin({ traceId: selected(), pinned: false }));
								setPinned(false);
							})
						}
					>
						{t("settings.diagnosticsUnpin")}
					</Button>
					<Button
						disabled={busy() || nextEvent() === undefined}
						onClick={() =>
							void run(async () => {
								const characterId = store.character?.id;
								const result = unwrap(
									await store.diagnostics.read({ traceId: selected(), offset: nextEvent() }),
								);
								if (characterId !== store.character?.id) return;
								setContent(result.content);
								setPayload("");
								setNextEvent(result.next);
							})
						}
					>
						{t("settings.diagnosticsNextPage")}
					</Button>
					<Button
						disabled={busy()}
						onClick={() =>
							void run(async () => {
								const characterId = store.character?.id;
								const result = unwrap(await store.diagnostics.metrics({}));
								if (characterId === store.character?.id) setPayload(result.content);
							})
						}
					>
						{t("settings.diagnosticsMetrics")}
					</Button>
				</div>
				<p>{t("settings.diagnosticsEventLimit")}</p>
				<div class="diagnostics-events">
					<For each={events()}>
						{(event) => (
							<details>
								<summary aria-label={`${event.event} ${event.eventId ?? "invalid"}`}>
									{new Date(event.at).toLocaleTimeString()} · {event.level.toUpperCase()} ·{" "}
									{event.event}
								</summary>
								<pre class="diagnostics-output">{JSON.stringify(event.attributes, null, 2)}</pre>
								<Show when={event.payload}>
									{(ref) => (
										<Button
											disabled={busy()}
											onClick={() =>
												void run(async () => {
													const characterId = store.character?.id;
													const result = unwrap(
														await store.diagnostics.payload({
															traceId: selected(),
															sha256: ref().sha256,
														}),
													);
													if (characterId === store.character?.id) setPayload(result.content);
												})
											}
										>
											{t("settings.diagnosticsReadPayload")} · {ref().bytes} B
										</Button>
									)}
								</Show>
							</details>
						)}
					</For>
				</div>
				<Show when={payload()}>
					<section aria-label={t("settings.diagnosticsPayload")}>
						<pre class="diagnostics-output">{payload()}</pre>
					</section>
				</Show>
			</Show>
		</section>
	);
}
