import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Select } from "@kobalte/core/select";
import { Tabs } from "@kobalte/core/tabs";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import {
	type MemoryCandidate,
	type MemoryEntry,
	type MemoryScope,
	useCompanionStore,
} from "../stores/companion.js";

/**
 * Memory management sheet (幕后 · 记忆).
 *
 * The list is backed by the companion memory records. Mutations are routed
 * through the store so the host remains the source of truth; this component
 * only handles loading state and the editing controls.
 */

/** Cap search queries client-side; the wire schema allows up to 4096 chars. */
const CLIENT_QUERY_LIMIT = 512;

/** Format an ISO-ish timestamp defensively; unparseable values pass through. */
function formatDate(value: string): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function kindLabel(kind: MemoryEntry["kind"]): string {
	switch (kind) {
		case "fact":
			return i18n.t("memory.kinds.fact");
		case "preference":
			return i18n.t("memory.kinds.preference");
		case "event":
			return i18n.t("memory.kinds.event");
		case "self_canon_summary":
			return i18n.t("memory.kinds.self_canon_summary");
		default:
			return kind;
	}
}

/** Entry list for one memory scope. */
export function MemoryEntryList(props: {
	scope: MemoryScope;
	query?: string;
	/** Bump to force a reload after a mutation. */
	refreshKey?: number;
	title?: string;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [entries, setEntries] = createSignal<MemoryEntry[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);
	const [busyId, setBusyId] = createSignal<string | null>(null);
	const [editingEntryId, setEditingEntryId] = createSignal<string | null>(null);
	const [editedEntryText, setEditedEntryText] = createSignal("");
	/**
	 * Memory ids excluded from recall, tracked locally: the entry list response
	 * does not echo the excluded flag, so the toggle is optimistic — call the
	 * RPC, then flip this set. The host does not send the flag back in list.
	 */
	const [excludedIds, setExcludedIds] = createSignal<ReadonlySet<string>>(new Set());

	let requestSeq = 0;

	async function reload(
		scope: MemoryScope = props.scope,
		query: string = props.query?.trim() ?? "",
	): Promise<void> {
		const seq = ++requestSeq;
		setLoading(true);
		setError(null);
		try {
			const normalizedQuery = query.trim();
			const result =
				normalizedQuery === ""
					? await store.memory.list({ scope })
					: await store.memory.search(normalizedQuery, scope);
			if (seq !== requestSeq) return;
			setEntries(result);
		} catch (e) {
			if (seq !== requestSeq) return;
			setEntries([]);
			setError(messageOf(e));
		} finally {
			if (seq === requestSeq) setLoading(false);
		}
	}

	createEffect(() => {
		void props.refreshKey;
		void reload(props.scope, props.query?.trim() ?? "");
	});

	async function runEntryAction(
		entryId: string,
		action: () => Promise<void>,
		success: string,
	): Promise<void> {
		setBusyId(entryId);
		setError(null);
		setFeedback(null);
		try {
			await action();
			setFeedback(success);
			await reload();
		} catch (e) {
			setError(messageOf(e));
		} finally {
			setBusyId(null);
		}
	}

	const forget = (entry: MemoryEntry) => () =>
		runEntryAction(entry.id, () => store.memory.forget(entry.id), t("memory.forget"));
	const toggleExclude = (entry: MemoryEntry) => async () => {
		const next = !excludedIds().has(entry.id);
		setBusyId(entry.id);
		setError(null);
		setFeedback(null);
		try {
			await store.memory.exclude(entry.id, next);
			const ids = new Set(excludedIds());
			if (next) ids.add(entry.id);
			else ids.delete(entry.id);
			setExcludedIds(ids);
			setFeedback(next ? t("memory.excludedDone") : t("memory.includedDone"));
		} catch (e) {
			setError(messageOf(e));
		} finally {
			setBusyId(null);
		}
	};
	const saveEdit = (entry: MemoryEntry) => async () => {
		const text = editedEntryText().trim();
		if (!text) return;
		await runEntryAction(entry.id, () => store.memory.edit(entry.id, text), t("memory.revised"));
		setEditingEntryId(null);
	};

	const title = () => props.title ?? t("memory.defaultEntriesTitle");

	return (
		<section class="memory-section" aria-label={title()}>
			<div class="section-head">
				<h3>{title()}</h3>
				<Show when={!loading() && entries().length > 0}>
					<span class="section-count">{entries().length}</span>
				</Show>
			</div>
			<Show when={feedback()}>
				<p class="status-line ok" role="status">
					{feedback()}
				</p>
			</Show>
			<Show when={error()}>
				<p class="status-line err" role="alert">
					{error()}
				</p>
			</Show>
			<Show when={loading() && entries().length === 0}>
				<p class="empty-note">{t("memory.loading")}</p>
			</Show>
			<Show when={!loading() && !error() && entries().length === 0}>
				<p class="empty-note">{t("memory.emptyEntries")}</p>
			</Show>
			<ul class="memory-list">
				<For each={entries()}>
					{(entry) => {
						const excluded = () => excludedIds().has(entry.id);
						return (
							<li class="memory-entry" data-excluded={excluded() ? "" : undefined}>
								<Show
									when={editingEntryId() === entry.id}
									fallback={<p class="memory-text">{entry.text}</p>}
								>
									<div class="memory-edit">
										<TextField>
											<TextField.TextArea
												rows={3}
												value={editedEntryText()}
												onInput={(event) => setEditedEntryText(event.currentTarget.value)}
												aria-label={t("memory.editedContent")}
											/>
										</TextField>
										<div class="memory-actions">
											<Button
												type="button"
												class="mini-btn primary"
												disabled={busyId() === entry.id || !editedEntryText().trim()}
												onClick={saveEdit(entry)}
											>
												{t("memory.saveEdit")}
											</Button>
											<Button
												type="button"
												class="mini-btn"
												onClick={() => setEditingEntryId(null)}
											>
												{t("messages.cancel")}
											</Button>
										</div>
									</div>
								</Show>
								<div class="memory-meta">
									<span class="memory-kind">{kindLabel(entry.kind)}</span>
									<Show when={excluded()}>
										<span class="memory-kind" data-excluded>
											{t("memory.excludedNote")}
										</span>
									</Show>
									<Show when={formatDate(entry.createdAt)}>
										<span>{formatDate(entry.createdAt)}</span>
									</Show>
								</div>
								<div class="memory-actions">
									<Button
										type="button"
										class="mini-btn"
										disabled={busyId() === entry.id}
										onClick={() => {
											setEditingEntryId(entry.id);
											setEditedEntryText(entry.text);
										}}
									>
										{t("memory.edit")}
									</Button>
									<Button
										type="button"
										class="mini-btn"
										aria-pressed={excluded() || undefined}
										disabled={busyId() === entry.id}
										onClick={toggleExclude(entry)}
									>
										{excluded() ? t("memory.included") : t("memory.exclude")}
									</Button>
									<Button
										type="button"
										class="mini-btn"
										disabled={busyId() === entry.id}
										onClick={forget(entry)}
									>
										{t("memory.forget")}
									</Button>
								</div>
							</li>
						);
					}}
				</For>
			</ul>
		</section>
	);
}

/** One pending memory candidate with an editable text + scope before approval. */
function CandidateCard(props: { candidate: MemoryCandidate }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [editedText, setEditedText] = createSignal(props.candidate.normalizedText);
	const [decidedScope, setDecidedScope] = createSignal<MemoryScope>(props.candidate.suggestedScope);
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const scopeOptions = (): MemoryScope[] => ["self", "relationship", "scene"];
	const scopeLabel = (scope: MemoryScope) => t(`memory.scopes.${scope}`);

	const approve = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			const text = editedText().trim();
			const edited = text && text !== props.candidate.normalizedText ? text : undefined;
			await store.memory.approveCandidate(props.candidate.id, edited, decidedScope());
		} catch (e) {
			setError(messageOf(e));
		} finally {
			setBusy(false);
		}
	};

	const reject = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			await store.memory.rejectCandidate(props.candidate.id);
		} catch (e) {
			setError(messageOf(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<li class="candidate-card">
			<p class="candidate-text">{props.candidate.normalizedText}</p>
			<p class="candidate-why">{props.candidate.why}</p>
			<div class="candidate-edit">
				<TextField>
					<TextField.TextArea
						rows={2}
						value={editedText()}
						onInput={(event) => setEditedText(event.currentTarget.value)}
						aria-label={t("memory.candidateEditedContent")}
					/>
				</TextField>
				<Select<MemoryScope>
					options={scopeOptions()}
					value={decidedScope()}
					optionValue={(scope) => scope}
					optionTextValue={scopeLabel}
					onChange={(scope) => {
						if (scope) setDecidedScope(scope);
					}}
					itemComponent={(itemProps) => (
						<Select.Item item={itemProps.item} class="select-item">
							<Select.ItemLabel>{scopeLabel(itemProps.item.rawValue)}</Select.ItemLabel>
						</Select.Item>
					)}
				>
					<Select.Label class="field-label">{t("memory.candidateScope")}</Select.Label>
					<Select.Trigger class="select-trigger" aria-label={t("memory.candidateScope")}>
						<Select.Value<MemoryScope> class="select-value">
							{(state) => scopeLabel(state.selectedOption())}
						</Select.Value>
						<Select.Icon class="select-icon" aria-hidden="true">
							v
						</Select.Icon>
					</Select.Trigger>
					<Select.Portal>
						<Select.Content class="select-content">
							<Select.Listbox class="select-listbox" />
						</Select.Content>
					</Select.Portal>
				</Select>
			</div>
			<Show when={error()}>
				<p class="status-line err" role="alert">
					{error()}
				</p>
			</Show>
			<div class="candidate-actions">
				<Button
					type="button"
					class="mini-btn primary"
					disabled={busy()}
					onClick={() => void approve()}
				>
					{t("memory.candidateApprove")}
				</Button>
				<Button type="button" class="mini-btn" disabled={busy()} onClick={() => void reject()}>
					{t("memory.candidateReject")}
				</Button>
			</div>
		</li>
	);
}

/** Pending memory candidates awaiting user confirmation (待确认记忆). */
export function MemoryCandidates() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	onMount(() => {
		setLoading(true);
		setError(null);
		void store.memory
			.listCandidates()
			.catch((e) => setError(messageOf(e)))
			.finally(() => setLoading(false));
	});

	const candidates = () => store.memory.candidates() ?? [];

	return (
		<section class="memory-section" aria-label={t("memory.candidatesTitle")}>
			<div class="section-head">
				<h3>{t("memory.candidatesTitle")}</h3>
				<Show when={!loading() && candidates().length > 0}>
					<span class="section-count">{candidates().length}</span>
				</Show>
			</div>
			<Show when={error()}>
				<p class="status-line err" role="alert">
					{error()}
				</p>
			</Show>
			<Show when={loading() && candidates().length === 0}>
				<p class="empty-note">{t("memory.loading")}</p>
			</Show>
			<Show when={!loading() && !error() && candidates().length === 0}>
				<p class="empty-note">{t("memory.candidatesEmpty")}</p>
			</Show>
			<ul class="candidate-list">
				<For each={candidates()}>{(candidate) => <CandidateCard candidate={candidate} />}</For>
			</ul>
		</section>
	);
}

/** Memory page: search and per-scope backend memory records. */
export function MemorySheet() {
	const [t] = useTranslation(undefined, { i18n });
	const scopeTabs = (): Array<{ value: MemoryScope; label: string }> => [
		{ value: "self", label: t("memory.scopes.self") },
		{ value: "relationship", label: t("memory.scopes.relationship") },
		{ value: "scene", label: t("memory.scopes.scene") },
	];
	const [scope, setScope] = createSignal<MemoryScope>("self");
	const [queryText, setQueryText] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [refreshKey, setRefreshKey] = createSignal(0);

	function onScopeChange(value: string): void {
		const next = scopeTabs().find((tab) => tab.value === value)?.value;
		if (!next) return;
		setScope(next);
		setQueryText("");
		setQuery("");
		setRefreshKey((key) => key + 1);
	}

	function submitSearch(): void {
		setQuery(queryText().trim().slice(0, CLIENT_QUERY_LIMIT));
	}

	function clearSearch(): void {
		setQueryText("");
		setQuery("");
	}

	return (
		<div class="sheet-panel">
			<div class="search-row">
				<TextField>
					<TextField.Input
						type="search"
						class="search-input"
						placeholder={t("memory.searchPlaceholder")}
						value={queryText()}
						onInput={(event) => setQueryText(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								submitSearch();
							}
						}}
						aria-label={t("memory.searchLabel")}
					/>
				</TextField>
				<Button type="button" class="mini-btn" onClick={submitSearch}>
					{t("memory.search")}
				</Button>
				<Show when={query() !== ""}>
					<Button type="button" class="mini-btn" onClick={clearSearch}>
						{t("memory.clear")}
					</Button>
				</Show>
			</div>

			<Tabs
				value={scope()}
				onChange={onScopeChange}
				class="scope-tabs"
				aria-label={t("memory.scopeTabsLabel")}
			>
				<Tabs.List class="tabs">
					<For each={scopeTabs()}>
						{(tab) => (
							<Tabs.Trigger value={tab.value} class="tab">
								{tab.label}
							</Tabs.Trigger>
						)}
					</For>
				</Tabs.List>
			</Tabs>

			<MemoryEntryList scope={scope()} query={query()} refreshKey={refreshKey()} />

			<MemoryCandidates />
		</div>
	);
}
