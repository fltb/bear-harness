import { productUi } from "@bear-harness/product-config";
import { Tabs } from "@kobalte/core";
import { createEffect, createSignal, For, Show } from "solid-js";
import {
	type MemoryDecision,
	type MemoryEntry,
	type MemoryScope,
	useCompanionStore,
} from "../stores/companion.js";

/**
 * Memory management sheet (幕后 · 记忆).
 *
 * Data flows through the companion store: candidates come from the reactive
 * `store.memory.candidates()`, entries are loaded per scope/query via
 * `store.memory.search`, and every mutation (approve / edit / reject / pin /
 * forget / exclude) calls the corresponding `store.memory.*` method, which
 * keeps the store's lists in sync. The store normalizes hostile bridge
 * payloads at the boundary; this sheet only surfaces failures in aria-live
 * status lines.
 */

export const SCOPE_LABELS: Record<MemoryScope, string> = productUi.memory.scopes;
const KIND_LABELS: Record<string, string> = productUi.memory.kinds;

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

/**
 * Entry list for one memory scope. Self-loading: searches the scope (all
 * entries when `query` is empty) and reloads after every mutation. `query`
 * must be a committed value — callers debounce via their own search box.
 */
export function MemoryEntryList(props: {
	scope: MemoryScope;
	query?: string;
	/** Bump to force a reload (e.g. after a candidate was approved). */
	refreshKey?: number;
	title?: string;
}) {
	const store = useCompanionStore();
	const [entries, setEntries] = createSignal<MemoryEntry[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);
	const [busyId, setBusyId] = createSignal<string | null>(null);
	const [editingEntryId, setEditingEntryId] = createSignal<string | null>(null);
	const [editedEntryText, setEditedEntryText] = createSignal("");

	let requestSeq = 0;

	async function reload(
		scope: MemoryScope = props.scope,
		query: string = props.query?.trim() ?? "",
	): Promise<void> {
		const seq = ++requestSeq;
		setLoading(true);
		setError(null);
		try {
			const result = await store.memory.search(query, scope);
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

	const togglePin = (entry: MemoryEntry) => () =>
		runEntryAction(
			entry.id,
			() => store.memory.pin(entry.id, !entry.pinned),
			entry.pinned ? productUi.memory.unpin : productUi.memory.pin,
		);
	const forget = (entry: MemoryEntry) => () =>
		runEntryAction(entry.id, () => store.memory.forget(entry.id), productUi.memory.forget);
	const exclude = (entry: MemoryEntry) => () =>
		runEntryAction(entry.id, () => store.memory.exclude(entry.id, true), productUi.memory.exclude);
	const saveEdit = (entry: MemoryEntry) => async () => {
		const text = editedEntryText().trim();
		if (!text) return;
		await runEntryAction(
			entry.id,
			() => store.memory.edit(entry.id, text),
			productUi.memory.approvedEdited,
		);
		setEditingEntryId(null);
	};

	const title = () => props.title ?? productUi.memory.defaultEntriesTitle;

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
				<p class="empty-note">{productUi.memory.loading}</p>
			</Show>
			<Show when={!loading() && !error() && entries().length === 0}>
				<p class="empty-note">{productUi.memory.emptyEntries}</p>
			</Show>
			<ul class="memory-list">
				<For each={entries()}>
					{(entry) => (
						<li class="memory-entry" data-pinned={entry.pinned || undefined}>
							<Show
								when={editingEntryId() === entry.id}
								fallback={<p class="memory-text">{entry.text}</p>}
							>
								<div class="candidate-edit">
									<textarea
										rows={3}
										value={editedEntryText()}
										onInput={(event) => setEditedEntryText(event.currentTarget.value)}
										aria-label={productUi.memory.editedContent}
									/>
									<div class="candidate-actions">
										<button
											type="button"
											class="mini-btn primary"
											disabled={busyId() === entry.id || !editedEntryText().trim()}
											onClick={saveEdit(entry)}
										>
											{productUi.memory.saveEdit}
										</button>
										<button type="button" class="mini-btn" onClick={() => setEditingEntryId(null)}>
											{productUi.messages.cancel}
										</button>
									</div>
								</div>
							</Show>
							<div class="memory-meta">
								<span class="memory-kind">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
								<span>
									{entry.sourceConversationTitle || productUi.memory.fallbackConversation}
								</span>
								<Show when={formatDate(entry.createdAt)}>
									<span>{formatDate(entry.createdAt)}</span>
								</Show>
								<Show when={entry.pinned}>
									<span class="pin-badge">{productUi.memory.pinned}</span>
								</Show>
							</div>
							<div class="memory-actions">
								<button
									type="button"
									class="mini-btn"
									disabled={busyId() === entry.id}
									onClick={() => {
										setEditingEntryId(entry.id);
										setEditedEntryText(entry.text);
									}}
								>
									{productUi.memory.edit}
								</button>
								<button
									type="button"
									class="mini-btn"
									disabled={busyId() === entry.id}
									onClick={togglePin(entry)}
								>
									{entry.pinned ? productUi.memory.unpin : productUi.memory.pin}
								</button>
								<button
									type="button"
									class="mini-btn"
									disabled={busyId() === entry.id}
									onClick={forget(entry)}
								>
									{productUi.memory.forget}
								</button>
								<button
									type="button"
									class="mini-btn"
									disabled={busyId() === entry.id}
									onClick={exclude(entry)}
								>
									{productUi.memory.exclude}
								</button>
							</div>
						</li>
					)}
				</For>
			</ul>
		</section>
	);
}

const SCOPE_TABS: ReadonlyArray<{ value: MemoryScope; label: string }> = [
	{ value: "self", label: productUi.memory.scopes.self },
	{ value: "relationship", label: productUi.memory.scopes.relationship },
	{ value: "scene", label: productUi.memory.scopes.scene },
];

/**
 * Memory page: scope filter (self / relationship / scene), search, the
 * pending-candidate inbox and the per-scope entry list. All mutations call
 * the corresponding `store.memory.*` methods.
 */
export function MemorySheet() {
	const store = useCompanionStore();
	const [scope, setScope] = createSignal<MemoryScope>("self");
	const [queryText, setQueryText] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [refreshKey, setRefreshKey] = createSignal(0);
	const [candidatesLoading, setCandidatesLoading] = createSignal(false);
	const [candidatesError, setCandidatesError] = createSignal<string | null>(null);
	const [editingId, setEditingId] = createSignal<string | null>(null);
	const [editedText, setEditedText] = createSignal("");
	const [busyId, setBusyId] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);

	/** Pending candidates only; the store keeps the full list reactive. */
	const pendingCandidates = () =>
		store.memory.candidates().filter((candidate) => candidate.status === "pending");

	async function reloadCandidates(): Promise<void> {
		setCandidatesLoading(true);
		setCandidatesError(null);
		try {
			await store.memory.listCandidates();
		} catch (e) {
			setCandidatesError(messageOf(e));
		} finally {
			setCandidatesLoading(false);
		}
	}

	createEffect(() => {
		void reloadCandidates();
	});

	function onScopeChange(value: string): void {
		const next = SCOPE_TABS.find((tab) => tab.value === value)?.value;
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

	async function decide(candidateId: string, decision: MemoryDecision): Promise<void> {
		setBusyId(candidateId);
		setCandidatesError(null);
		setFeedback(null);
		try {
			const candidate = pendingCandidates().find((item) => item.id === candidateId);
			await store.memory.decideCandidate(candidateId, decision, undefined, candidate?.scope);
			setFeedback(
				decision === "approve"
					? productUi.memory.approved
					: decision === "reject"
						? productUi.memory.rejected
						: productUi.memory.saved,
			);
			setEditingId(null);
			setRefreshKey((key) => key + 1);
		} catch (e) {
			setCandidatesError(messageOf(e));
		} finally {
			setBusyId(null);
		}
	}

	async function saveEdited(candidateId: string): Promise<void> {
		const text = editedText().trim();
		if (!text) return;
		setBusyId(candidateId);
		setCandidatesError(null);
		setFeedback(null);
		try {
			const candidate = pendingCandidates().find((item) => item.id === candidateId);
			await store.memory.decideCandidate(candidateId, "approve_edited", text, candidate?.scope);
			setFeedback(productUi.memory.approvedEdited);
			setEditingId(null);
			setRefreshKey((key) => key + 1);
		} catch (e) {
			setCandidatesError(messageOf(e));
		} finally {
			setBusyId(null);
		}
	}

	return (
		<div class="sheet-panel">
			<section class="candidates-section" aria-label={productUi.memory.recentCandidates}>
				<div class="section-head">
					<h3>{productUi.memory.recentCandidates}</h3>
					<Show when={!candidatesLoading() && pendingCandidates().length > 0}>
						<span class="section-count">{pendingCandidates().length}</span>
					</Show>
				</div>
				<p class="drawer-note">{productUi.memory.candidatesNote}</p>
				<Show when={feedback()}>
					<p class="status-line ok" role="status">
						{feedback()}
					</p>
				</Show>
				<Show when={candidatesError()}>
					<p class="status-line err" role="alert">
						{candidatesError()}
					</p>
				</Show>
				<Show when={candidatesLoading() && pendingCandidates().length === 0}>
					<p class="empty-note">{productUi.memory.loading}</p>
				</Show>
				<Show when={!candidatesLoading() && !candidatesError() && pendingCandidates().length === 0}>
					<p class="empty-note">{productUi.memory.noCandidates}</p>
				</Show>
				<ul class="candidate-list">
					<For each={pendingCandidates()}>
						{(candidate) => (
							<li class="candidate-card">
								<p class="candidate-text">{candidate.text}</p>
								<Show when={candidate.why}>
									<p class="candidate-why">{candidate.why}</p>
								</Show>
								<div class="candidate-meta">
									<span class="memory-kind">{KIND_LABELS[candidate.kind] ?? candidate.kind}</span>
									<span>{SCOPE_LABELS[candidate.scope]}</span>
									<Show when={formatDate(candidate.createdAt)}>
										<span>{formatDate(candidate.createdAt)}</span>
									</Show>
								</div>
								<Show
									when={editingId() === candidate.id}
									fallback={
										<div class="candidate-actions">
											<button
												type="button"
												class="mini-btn primary"
												disabled={busyId() === candidate.id}
												onClick={() => decide(candidate.id, "approve")}
											>
												{productUi.memory.remember}
											</button>
											<button
												type="button"
												class="mini-btn"
												disabled={busyId() === candidate.id}
												onClick={() => {
													setEditingId(candidate.id);
													setEditedText(candidate.text);
												}}
											>
												{productUi.memory.edit}
											</button>
											<button
												type="button"
												class="mini-btn danger"
												disabled={busyId() === candidate.id}
												onClick={() => decide(candidate.id, "reject")}
											>
												{productUi.memory.reject}
											</button>
										</div>
									}
								>
									<div class="candidate-edit">
										<textarea
											rows={3}
											value={editedText()}
											onInput={(event) => setEditedText(event.currentTarget.value)}
											aria-label={productUi.memory.editedContent}
										/>
										<div class="candidate-actions">
											<button
												type="button"
												class="mini-btn primary"
												disabled={busyId() === candidate.id || !editedText().trim()}
												onClick={() => saveEdited(candidate.id)}
											>
												{productUi.memory.saveEdit}
											</button>
											<button
												type="button"
												class="mini-btn"
												disabled={busyId() === candidate.id}
												onClick={() => setEditingId(null)}
											>
												{productUi.messages.cancel}
											</button>
										</div>
									</div>
								</Show>
							</li>
						)}
					</For>
				</ul>
			</section>

			<div class="search-row">
				<input
					type="search"
					class="search-input"
					placeholder={productUi.memory.searchPlaceholder}
					value={queryText()}
					onInput={(event) => setQueryText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							submitSearch();
						}
					}}
					aria-label={productUi.memory.searchLabel}
				/>
				<button type="button" class="mini-btn" onClick={submitSearch}>
					{productUi.memory.search}
				</button>
				<Show when={query() !== ""}>
					<button type="button" class="mini-btn" onClick={clearSearch}>
						{productUi.memory.clear}
					</button>
				</Show>
			</div>

			<Tabs.Root
				value={scope()}
				onChange={onScopeChange}
				class="scope-tabs"
				aria-label={productUi.memory.scopeTabsLabel}
			>
				<Tabs.List class="tabs">
					<For each={SCOPE_TABS}>
						{(tab) => (
							<Tabs.Trigger value={tab.value} class="tab">
								{tab.label}
							</Tabs.Trigger>
						)}
					</For>
				</Tabs.List>
			</Tabs.Root>

			<MemoryEntryList scope={scope()} query={query()} refreshKey={refreshKey()} />
		</div>
	);
}
