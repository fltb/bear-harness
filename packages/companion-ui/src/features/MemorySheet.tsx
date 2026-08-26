import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Select } from "@kobalte/core/select";
import { Tabs } from "@kobalte/core/tabs";
import { TextField } from "@kobalte/core/text-field";
import { For, Show } from "solid-js";
import { createBackstageWorkflowStore } from "../stores/backstage-workflows.js";
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

/** Format an ISO-ish timestamp defensively; unparseable values pass through. */
function formatDate(value: string): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
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
	refreshKey?: number;
	title?: string;
	characterId?: string;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const companion = useCompanionStore();
	const workflow = createBackstageWorkflowStore(companion);
	const scope = () => props.scope;
	const query = () => props.query?.trim() ?? "";
	const refresh = () => props.refreshKey ?? 0;
	const characterId = () => props.characterId;
	const state = workflow.memoryEntryList(scope, query, refresh, characterId);
	const title = () => props.title ?? t("memory.defaultEntriesTitle");

	return (
		<section class="memory-section" aria-label={title()}>
			<div class="section-head">
				<h3>{title()}</h3>
				<Show when={!state.loading() && state.entries().length > 0}>
					<span class="section-count">{state.entries().length}</span>
				</Show>
			</div>
			<Show when={state.feedback()}>
				<p class="status-line ok" role="status">
					{state.feedback()}
				</p>
			</Show>
			<Show when={state.error()}>
				<p class="status-line err" role="alert">
					{state.error()}
				</p>
			</Show>
			<Show when={state.loading() && state.entries().length === 0}>
				<p class="empty-note">{t("memory.loading")}</p>
			</Show>
			<Show when={!state.loading() && !state.error() && state.entries().length === 0}>
				<p class="empty-note">{t("memory.emptyEntries")}</p>
			</Show>
			<ul class="memory-list">
				<For each={state.entries()}>
					{(entry) => {
						const excluded = state.excluded(entry.id);
						return (
							<li class="memory-entry" data-excluded={excluded() ? "" : undefined}>
								<Show
									when={state.editingEntryId() === entry.id}
									fallback={<p class="memory-text">{entry.text}</p>}
								>
									<div class="memory-edit">
										<TextField>
											<TextField.TextArea
												rows={3}
												value={state.editedEntryText()}
												onInput={(event) => state.setEditedEntryText(event.currentTarget.value)}
												aria-label={t("memory.editedContent")}
											/>
										</TextField>
										<div class="memory-actions">
											<Button
												type="button"
												class="mini-btn primary"
												disabled={state.busyId() === entry.id || !state.editedEntryText().trim()}
												onClick={() => state.saveEdit(entry, t("memory.revised"))}
											>
												{t("memory.saveEdit")}
											</Button>
											<Button type="button" class="mini-btn" onClick={state.cancelEditing}>
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
										disabled={state.busyId() === entry.id}
										onClick={() => state.startEditing(entry)}
									>
										{t("memory.edit")}
									</Button>
									<Button
										type="button"
										class="mini-btn"
										aria-pressed={excluded() || undefined}
										disabled={state.busyId() === entry.id}
										onClick={() =>
											state.toggleExclude(entry, t("memory.includedDone"), t("memory.excludedDone"))
										}
									>
										{excluded() ? t("memory.included") : t("memory.exclude")}
									</Button>
									<Button
										type="button"
										class="mini-btn"
										disabled={state.busyId() === entry.id}
										onClick={() => state.forget(entry, t("memory.forget"))}
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
	const workflow = createBackstageWorkflowStore(useCompanionStore());
	const state = workflow.memoryCandidate(() => props.candidate);
	const scopeOptions: MemoryScope[] = ["self", "relationship", "scene"];
	const scopeLabel = (scope: MemoryScope) => t(`memory.scopes.${scope}`);
	return (
		<li class="candidate-card">
			<p class="candidate-text">{props.candidate.normalizedText}</p>
			<p class="candidate-why">{props.candidate.why}</p>
			<div class="candidate-edit">
				<TextField>
					<TextField.TextArea
						rows={2}
						value={state.editedText()}
						onInput={(event) => state.setEditedText(event.currentTarget.value)}
						aria-label={t("memory.candidateEditedContent")}
					/>
				</TextField>
				<Select<MemoryScope>
					options={scopeOptions}
					value={state.decidedScope()}
					optionValue={(scope) => scope}
					optionTextValue={scopeLabel}
					onChange={(scope) => {
						if (scope) state.setDecidedScope(scope);
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
							{(current) => scopeLabel(current.selectedOption())}
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
			<Show when={state.error()}>
				<p class="status-line err" role="alert">
					{state.error()}
				</p>
			</Show>
			<div class="candidate-actions">
				<Button
					type="button"
					class="mini-btn primary"
					disabled={state.busy()}
					onClick={state.approve}
				>
					{t("memory.candidateApprove")}
				</Button>
				<Button type="button" class="mini-btn" disabled={state.busy()} onClick={state.reject}>
					{t("memory.candidateReject")}
				</Button>
			</div>
		</li>
	);
}

/** Pending memory candidates awaiting user confirmation (待确认记忆). */
export function MemoryCandidates(props: { scopes?: readonly MemoryScope[] } = {}) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = createBackstageWorkflowStore(useCompanionStore());
	const candidates = () =>
		workflow
			.memoryCandidates()
			.filter((candidate) =>
				(props.scopes ?? ["self", "scene"]).includes(candidate.suggestedScope),
			);
	return (
		<section class="memory-section" aria-label={t("memory.candidatesTitle")}>
			<div class="section-head">
				<h3>{t("memory.candidatesTitle")}</h3>
				<Show when={!workflow.memoryCandidatesLoading() && candidates().length > 0}>
					<span class="section-count">{candidates().length}</span>
				</Show>
			</div>
			<Show when={workflow.memoryCandidatesError()}>
				<p class="status-line err" role="alert">
					{workflow.memoryCandidatesError()}
				</p>
			</Show>
			<Show when={workflow.memoryCandidatesLoading() && candidates().length === 0}>
				<p class="empty-note">{t("memory.loading")}</p>
			</Show>
			<Show
				when={
					!workflow.memoryCandidatesLoading() &&
					!workflow.memoryCandidatesError() &&
					candidates().length === 0
				}
			>
				<p class="empty-note">{t("memory.candidatesEmpty")}</p>
			</Show>
			<ul class="candidate-list">
				<For each={candidates()}>{(candidate) => <CandidateCard candidate={candidate} />}</For>
			</ul>
		</section>
	);
}

/** Memory page: search and per-scope backend memory records. */
export function MemorySheet(props: { characterId?: string; scopes?: readonly MemoryScope[] } = {}) {
	const [t] = useTranslation(undefined, { i18n });
	const workflow = createBackstageWorkflowStore(useCompanionStore());
	const scopeTabs = () =>
		workflow
			.memoryScopeTabs((scope) => t(`memory.scopes.${scope}`))()
			.filter((tab) => (props.scopes ?? ["self", "scene"]).includes(tab.value));
	return (
		<div class="sheet-panel">
			<div class="search-row">
				<TextField>
					<TextField.Input
						type="search"
						class="search-input"
						placeholder={t("memory.searchPlaceholder")}
						value={workflow.memoryQueryText()}
						onInput={(event) => workflow.setMemoryQueryText(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								workflow.submitMemorySearch();
							}
						}}
						aria-label={t("memory.searchLabel")}
					/>
				</TextField>
				<Button type="button" class="mini-btn" onClick={workflow.submitMemorySearch}>
					{t("memory.search")}
				</Button>
				<Show when={workflow.memoryQuery() !== ""}>
					<Button type="button" class="mini-btn" onClick={workflow.clearMemorySearch}>
						{t("memory.clear")}
					</Button>
				</Show>
			</div>
			<Tabs
				value={workflow.memoryScope()}
				onChange={workflow.changeMemoryScope}
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
			<MemoryEntryList
				scope={workflow.memoryScope()}
				query={workflow.memoryQuery()}
				refreshKey={workflow.memoryRefreshKey()}
				characterId={props.characterId}
			/>
			<MemoryCandidates />
		</div>
	);
}
