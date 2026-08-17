import { i18n, useTranslation } from "@bear-harness/i18n";
import { Tabs } from "@kobalte/core/tabs";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createSignal, For, Show } from "solid-js";
import {
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

/**
 * The current wire projection predates the direct backend provenance fields.
 * Accept both projections during the migration without making the panel
 * depend on a second read path.
 */
type MemoryEntryWithSource = MemoryEntry & {
	createdBy?: string;
	source?: string;
	sourceKind?: string;
	provenance?: { kind?: string };
};

function isMemoryEntryWithSource(entry: MemoryEntry): entry is MemoryEntryWithSource {
	return (
		"createdBy" in entry ||
		"source" in entry ||
		"sourceKind" in entry ||
		"provenance" in entry
	);
}

function sourceLabel(entry: MemoryEntry): string {
	if (!isMemoryEntryWithSource(entry)) return i18n.t("memory.sourceAutomatic");
	const source = entry.createdBy ?? entry.source ?? entry.sourceKind ?? entry.provenance?.kind;
	return source === "user_capture" ||
		source === "user_button" ||
		source === "user_request" ||
		source === "explicit" ||
		source === "imported"
		? i18n.t("memory.sourceUser")
		: i18n.t("memory.sourceAutomatic");
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
			entry.pinned ? t("memory.unpin") : t("memory.pin"),
		);
	const forget = (entry: MemoryEntry) => () =>
		runEntryAction(entry.id, () => store.memory.forget(entry.id), t("memory.forget"));
	const invalidate = (entry: MemoryEntry) => () =>
		runEntryAction(entry.id, () => store.memory.invalidate(entry.id), t("memory.invalidated"));
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
					{(entry) => (
						<li class="memory-entry" data-pinned={entry.pinned || undefined}>
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
										<Button type="button" class="mini-btn" onClick={() => setEditingEntryId(null)}>
											{t("messages.cancel")}
										</Button>
									</div>
								</div>
							</Show>
							<div class="memory-meta">
								<span class="memory-kind">{kindLabel(entry.kind)}</span>
								<span class="memory-source">{sourceLabel(entry)}</span>
								<span>{entry.sourceConversationTitle || t("memory.fallbackConversation")}</span>
								<Show when={formatDate(entry.createdAt)}>
									<span>{formatDate(entry.createdAt)}</span>
								</Show>
								<Show when={entry.pinned}>
									<span class="pin-badge">{t("memory.pinned")}</span>
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
									disabled={busyId() === entry.id}
									onClick={togglePin(entry)}
								>
									{entry.pinned ? t("memory.unpin") : t("memory.pin")}
								</Button>
								<Button
									type="button"
									class="mini-btn"
									disabled={busyId() === entry.id}
									onClick={forget(entry)}
								>
									{t("memory.forget")}
								</Button>
								<Button
									type="button"
									class="mini-btn danger"
									disabled={busyId() === entry.id}
									onClick={invalidate(entry)}
								>
									{t("memory.invalidate")}
								</Button>
							</div>
						</li>
					)}
				</For>
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
		</div>
	);
}
