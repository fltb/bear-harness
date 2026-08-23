import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type {
	CanonChunk,
	CanonModuleKind,
	CharacterDisplay,
	CharacterSummary,
	MemoryCandidate,
	MemoryEntry,
	MemoryScope,
} from "./companion.js";
import type { CompanionStore } from "./companion.js";

export type BackstageTab = "relationship" | "roles" | "memory" | "studio";
interface PluginTrust {
	origin: "official" | "local" | "imported";
	pluginHash: string;
	trusted: boolean;
	pluginsPresent: boolean;
}
const DEFAULT_PLUGIN_TRUST: PluginTrust = {
	origin: "official",
	pluginHash: "",
	pluginsPresent: false,
	trusted: true,
};
const CANON_KINDS: readonly CanonModuleKind[] = [
	"root",
	"arc",
	"event",
	"entity",
	"relationship",
	"location",
	"object",
	"behavior",
];
const MEMORY_SCOPES: readonly MemoryScope[] = ["self", "relationship", "scene"];
const CLIENT_QUERY_LIMIT = 512;

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

interface MemoryListState {
	entries: MemoryEntry[];
	loading: boolean;
	error: string | null;
	feedback: string | null;
	busyId: string | null;
	editingEntryId: string | null;
	editedEntryText: string;
	excludedIds: ReadonlySet<string>;
}
const EMPTY_MEMORY_LIST: MemoryListState = {
	entries: [],
	loading: false,
	error: null,
	feedback: null,
	busyId: null,
	editingEntryId: null,
	editedEntryText: "",
	excludedIds: new Set(),
};

interface CandidateState {
	editedText: string;
	decidedScope: MemoryScope;
	busy: boolean;
	error: string | null;
}

export interface MemoryEntryListSelectors {
	entries: Accessor<MemoryEntry[]>;
	loading: Accessor<boolean>;
	error: Accessor<string | null>;
	excluded(entryId: string): Accessor<boolean>;
	feedback: Accessor<string | null>;
	busyId: Accessor<string | null>;
	editingEntryId: Accessor<string | null>;
	editedEntryText: Accessor<string>;
	excludedIds: Accessor<ReadonlySet<string>>;
	setEditedEntryText(value: string): void;
	startEditing(entry: MemoryEntry): void;
	cancelEditing(): void;
	forget(entry: MemoryEntry, success: string): void;
	toggleExclude(entry: MemoryEntry, included: string, excluded: string): void;
	saveEdit(entry: MemoryEntry, success: string): void;
}

export interface MemoryCandidateSelectors {
	editedText: Accessor<string>;
	decidedScope: Accessor<MemoryScope>;
	busy: Accessor<boolean>;
	error: Accessor<string | null>;
	setEditedText(value: string): void;
	setDecidedScope(value: MemoryScope): void;
	approve(): void;
	reject(): void;
}

export interface CanonWorkflowSelectors {
	moduleKinds: Accessor<Array<{ id: CanonModuleKind; label: string }>>;
	parentModules: Accessor<import("./ipc.js").CanonModule[]>;
	sources: Accessor<import("./ipc.js").CanonSource[]>;
	modules: Accessor<import("./ipc.js").CanonModule[]>;
	results: Accessor<CanonChunk[]>;
	selectedChunks: Accessor<string[]>;
	busy: Accessor<boolean>;
	sourceName: Accessor<string>;
	sourceText: Accessor<string>;
	query: Accessor<string>;
	moduleTitle: Accessor<string>;
	moduleInstructions: Accessor<string>;
	moduleKind: Accessor<CanonModuleKind>;
	moduleParentId: Accessor<string>;
	editingModuleId: Accessor<string | undefined>;
	setSourceName(value: string): void;
	setSourceText(value: string): void;
	setQuery(value: string): void;
	setModuleTitle(value: string): void;
	setModuleInstructions(value: string): void;
	setModuleKind(value: CanonModuleKind): void;
	setModuleParentId(value: string): void;
	setSelectedChunks(value: string[]): void;
	addSource(): void;
	removeSource(sourceId: string): void;
	search(): void;
	toggleChunk(chunkId: string, checked: boolean): void;
	saveModule(): void;
	editModule(module: import("./ipc.js").CanonModule): void;
	deleteModule(moduleId: string): void;
	clearModuleForm(): void;
}

export interface RoleplaySelectors {
	visibleVariables: Accessor<CharacterDisplay["roleplay"]["variables"]>;
	collections: Accessor<CharacterDisplay["roleplay"]["unlockables"]>;
	mediaFor(id: string | undefined): Accessor<CharacterDisplay["roleplay"]["media"][number] | undefined>;
	displayValue(variable: CharacterDisplay["roleplay"]["variables"][number]): Accessor<string>;
}

export interface BackstageWorkflowStore {
	selectedTab: Accessor<BackstageTab>;
	setSelectedTab(value: string): void;
	syncInitialTab(value: "roles" | "settings" | undefined): void;
	roleBusyId: Accessor<string | undefined>;
	importing: Accessor<boolean>;
	roleFeedback: Accessor<string | undefined>;
	importPackage(files: File[], done: string, failed: string): void;
	characters: Accessor<CharacterSummary[]>;
	pluginTrust(id: string): Accessor<PluginTrust | undefined>;
	pluginTrustLoading(id: string): Accessor<boolean>;
	confirmingPlugins(id: string): Accessor<boolean>;
	setConfirmingPlugins(id: string, value: boolean): void;
	enablePlugins(id: string): void;
	activateRole(id: string): void;
	canon(noParentTitle: Accessor<string>, kindLabel: (kind: CanonModuleKind) => string): CanonWorkflowSelectors;
	relationshipEnabled: Accessor<boolean>;
	historyReadEnabled: Accessor<boolean>;
	settingsAvailable: Accessor<boolean>;
	relationshipSaving: Accessor<boolean>;
	relationshipFeedback: Accessor<string | undefined>;
	relationshipError: Accessor<string | undefined>;
	toggleRelationshipMemory(enabledLabel: string, disabledLabel: string, genericError: string): void;
	toggleHistoryRead(genericError: string): void;
	roleplay(): RoleplaySelectors;
	memoryScope: Accessor<MemoryScope>;
	memoryQueryText: Accessor<string>;
	memoryQuery: Accessor<string>;
	memoryRefreshKey: Accessor<number>;
	memoryScopeTabs(label: (scope: MemoryScope) => string): Accessor<Array<{ value: MemoryScope; label: string }>>;
	setMemoryQueryText(value: string): void;
	submitMemorySearch(): void;
	clearMemorySearch(): void;
	changeMemoryScope(value: string): void;
	memoryEntryList(scope: Accessor<MemoryScope>, query: Accessor<string>, refresh: Accessor<number>): MemoryEntryListSelectors;
	memoryCandidates: Accessor<MemoryCandidate[]>;
	memoryCandidatesLoading: Accessor<boolean>;
	memoryCandidatesError: Accessor<string | null>;
	memoryCandidate(candidate: Accessor<MemoryCandidate>): MemoryCandidateSelectors;
}

const WORKFLOW_STORES = new WeakMap<CompanionStore, BackstageWorkflowStore>();

export function createBackstageWorkflowStore(companion: CompanionStore): BackstageWorkflowStore {
	const existing = WORKFLOW_STORES.get(companion);
	if (existing) return existing;

	const [selectedTab, setSelectedTabState] = createSignal<BackstageTab>("roles");
	const [roleBusyId, setRoleBusyId] = createSignal<string>();
	const [importing, setImporting] = createSignal(false);
	const [roleFeedback, setRoleFeedback] = createSignal<string>();
	const [trustById, setTrustById] = createSignal<Record<string, PluginTrust>>({});
	const [trustLoadingById, setTrustLoadingById] = createSignal<Record<string, boolean>>({});
	const [confirmingById, setConfirmingById] = createSignal<Record<string, boolean>>({});
	const trustRequests = new Set<string>();
	const loadTrust = async (id: string, force = false): Promise<void> => {
		if (!force && trustRequests.has(id)) return;
		trustRequests.add(id);
		setTrustLoadingById((current) => ({ ...current, [id]: true }));
		try {
			const trust = companion.characters?.pluginTrust
				? await companion.characters.pluginTrust(id)
				: DEFAULT_PLUGIN_TRUST;
			setTrustById((current) => ({ ...current, [id]: trust }));
		} finally {
			setTrustLoadingById((current) => ({ ...current, [id]: false }));
		}
	};

	const [relationshipSaving, setRelationshipSaving] = createSignal(false);
	const [relationshipFeedback, setRelationshipFeedback] = createSignal<string>();
	const [relationshipError, setRelationshipError] = createSignal<string>();
	let settingsRequested = false;
	const settingsData = createMemo(() => {
		const api = companion.settings;
		const data = api?.data?.();
		if (data === undefined && !settingsRequested && api?.get) {
			settingsRequested = true;
			void Promise.resolve()
				.then(() => api.get())
				.catch((error) => setRelationshipError(messageOf(error)));
		}
		return data;
	});
	const relationshipEnabled = createMemo(() => settingsData()?.relationshipMemoryEnabled ?? false);
	const historyReadEnabled = createMemo(() => settingsData()?.conversationHistoryReadEnabled ?? false);
	const settingsAvailable = createMemo(() => settingsData() !== undefined);

	const [canonSourceName, setCanonSourceName] = createSignal("");
	const [canonSourceText, setCanonSourceText] = createSignal("");
	const [canonQuery, setCanonQuery] = createSignal("");
	const [canonResults, setCanonResults] = createSignal<CanonChunk[]>([]);
	const [canonModuleTitle, setCanonModuleTitle] = createSignal("");
	const [canonModuleInstructions, setCanonModuleInstructions] = createSignal("");
	const [canonModuleKind, setCanonModuleKind] = createSignal<CanonModuleKind>("arc");
	const [canonModuleParentId, setCanonModuleParentId] = createSignal("");
	const [canonEditingModuleId, setCanonEditingModuleId] = createSignal<string>();
	const [canonSelectedChunks, setCanonSelectedChunks] = createSignal<string[]>([]);
	const [canonBusy, setCanonBusy] = createSignal(false);
	let canonSearchSeq = 0;
	let canonRequested = false;
	const ensureCanonLoaded = (): void => {
		if (canonRequested) return;
		canonRequested = true;
		const api = companion.canon;
		if (!api) return;
		const requests: Promise<void>[] = [];
		if (api.listSources) requests.push(Promise.resolve().then(() => api.listSources()));
		if (api.listModules) requests.push(Promise.resolve().then(() => api.listModules()));
		if (requests.length > 0) void Promise.all(requests).catch(() => undefined);
	};
	const canonSelectors = new Map<string, CanonWorkflowSelectors>();
	const createCanonSelectors = (noParentTitle: Accessor<string>, kindLabel: (kind: CanonModuleKind) => string): CanonWorkflowSelectors => {
		ensureCanonLoaded();
		const existingSelectors = canonSelectors.get(noParentTitle.toString());
		if (existingSelectors) return existingSelectors;
		const moduleKinds = createMemo(() => CANON_KINDS.map((id) => ({ id, label: kindLabel(id) })));
		const parentModules = createMemo(() => [
			{
				id: "",
				kind: "root" as const,
				title: noParentTitle(),
				instructions: "",
				sourceChunkIds: [],
				createdAt: "",
				origin: "user" as const,
				triggers: [],
			},
			...(companion.canon?.modules?.() ?? []).filter((module) => module.id !== canonEditingModuleId()),
		]);
		const selectors: CanonWorkflowSelectors = {
			moduleKinds,
			parentModules,
			sources: createMemo(() => companion.canon?.sources?.() ?? []),
			modules: createMemo(() => companion.canon?.modules?.() ?? []),
			results: canonResults,
			selectedChunks: canonSelectedChunks,
			busy: canonBusy,
			sourceName: canonSourceName,
			sourceText: canonSourceText,
			query: canonQuery,
			moduleTitle: canonModuleTitle,
			moduleInstructions: canonModuleInstructions,
			moduleKind: canonModuleKind,
			moduleParentId: canonModuleParentId,
			editingModuleId: canonEditingModuleId,
			setSourceName: setCanonSourceName,
			setSourceText: setCanonSourceText,
			setQuery: setCanonQuery,
			setModuleTitle: setCanonModuleTitle,
			setModuleInstructions: setCanonModuleInstructions,
			setModuleKind: setCanonModuleKind,
			setModuleParentId: setCanonModuleParentId,
			setSelectedChunks: setCanonSelectedChunks,
			addSource: () => {
				const name = canonSourceName().trim();
				const text = canonSourceText();
				const api = companion.canon;
				if (!name || !text.trim() || !api?.addSource) return;
				setCanonBusy(true);
				void Promise.resolve()
					.then(() => api.addSource(name, text))
					.then(() => {
						setCanonSourceName("");
						setCanonSourceText("");
					})
					.finally(() => setCanonBusy(false));
			},
			removeSource: (sourceId) => {
				const api = companion.canon;
				if (api?.removeSource) void Promise.resolve().then(() => api.removeSource(sourceId));
			},
			search: () => {
				const query = canonQuery().trim();
				const api = companion.canon;
				if (!query || !api?.search) return;
				const seq = ++canonSearchSeq;
				void Promise.resolve()
					.then(() => api.search(query))
					.then((result) => {
						if (seq === canonSearchSeq) setCanonResults(result);
					});
			},
			toggleChunk: (chunkId, checked) => setCanonSelectedChunks((current) =>
				checked ? (current.includes(chunkId) ? current : [...current, chunkId]) : current.filter((id) => id !== chunkId),
			),
			saveModule: () => {
				const title = canonModuleTitle().trim();
				const api = companion.canon;
				if (!title || !api?.upsertModule) return;
				setCanonBusy(true);
				void Promise.resolve()
					.then(() => api.upsertModule({
						...(canonEditingModuleId() ? { id: canonEditingModuleId() } : {}),
						...(canonModuleParentId() ? { parentId: canonModuleParentId() } : {}),
						kind: canonModuleKind(), title, instructions: canonModuleInstructions().trim(),
						sourceChunkIds: canonSelectedChunks(),
					}))
					.then(() => selectors.clearModuleForm())
					.finally(() => setCanonBusy(false));
			},
			editModule: (module) => {
				setCanonEditingModuleId(module.id); setCanonModuleParentId(module.parentId ?? "");
				setCanonModuleKind(module.kind); setCanonModuleTitle(module.title);
				setCanonModuleInstructions(module.instructions); setCanonSelectedChunks(module.sourceChunkIds);
			},
			deleteModule: (moduleId) => {
				const api = companion.canon;
				if (api?.deleteModule) void Promise.resolve().then(() => api.deleteModule(moduleId));
			},
			clearModuleForm: () => {
				setCanonModuleTitle(""); setCanonModuleInstructions(""); setCanonModuleKind("arc");
				setCanonModuleParentId(""); setCanonEditingModuleId(undefined); setCanonSelectedChunks([]);
			},
		};
		canonSelectors.set(noParentTitle.toString(), selectors);
		return selectors;
	};

	const [memoryScope, setMemoryScope] = createSignal<MemoryScope>("self");
	const [memoryQueryText, setMemoryQueryText] = createSignal("");
	const [memoryQuery, setMemoryQuery] = createSignal("");
	const [memoryRefreshKey, setMemoryRefreshKey] = createSignal(0);
	const memoryScopeTabs = new Map<string, Accessor<Array<{ value: MemoryScope; label: string }>>>();
	const memoryScopeTabSelector = (label: (scope: MemoryScope) => string) => {
		const key = label.toString();
		const existingSelector = memoryScopeTabs.get(key);
		if (existingSelector) return existingSelector;
		const selector = createMemo(() => MEMORY_SCOPES.map((value) => ({ value, label: label(value) })));
		memoryScopeTabs.set(key, selector);
		return selector;
	};
	const changeMemoryScope = (value: string): void => {
		const next = MEMORY_SCOPES.find((candidate) => candidate === value);
		if (!next) return;
		setMemoryScope(next); setMemoryQueryText(""); setMemoryQuery(""); setMemoryRefreshKey((key) => key + 1);
	};
	const submitMemorySearch = (): void => {
		setMemoryQuery(memoryQueryText().trim().slice(0, CLIENT_QUERY_LIMIT));
	};
	const clearMemorySearch = (): void => { setMemoryQueryText(""); setMemoryQuery(""); };

	const [memoryLists, setMemoryLists] = createSignal<Record<string, MemoryListState>>({});
	const memoryRequestSeq = new Map<string, number>();
	const listKey = (scope: MemoryScope, query: string): string => `${scope}\u0000${query}`;
	const patchMemoryList = (key: string, patch: Partial<MemoryListState>): void => {
		setMemoryLists((current) => ({ ...current, [key]: { ...(current[key] ?? EMPTY_MEMORY_LIST), ...patch } }));
	};
	const reloadMemoryList = async (scope: MemoryScope, query: string): Promise<void> => {
		const key = listKey(scope, query);
		const seq = (memoryRequestSeq.get(key) ?? 0) + 1;
		memoryRequestSeq.set(key, seq);
		patchMemoryList(key, { loading: true, error: null });
		const api = companion.memory;
		if (!api || (query === "" ? !api.list : !api.search)) {
			patchMemoryList(key, { entries: [], loading: false });
			return;
		}
		try {
			const entries = query === ""
				? await api.list({ scope })
				: await api.search(query, scope);
			if (memoryRequestSeq.get(key) !== seq) return;
			patchMemoryList(key, { entries });
		} catch (error) {
			if (memoryRequestSeq.get(key) !== seq) return;
			patchMemoryList(key, { entries: [], error: messageOf(error) });
		} finally {
			if (memoryRequestSeq.get(key) === seq) patchMemoryList(key, { loading: false });
		}
	};
	const memoryListSelectors = new Map<string, MemoryEntryListSelectors>();
	const memoryEntryList = (scope: Accessor<MemoryScope>, query: Accessor<string>, refresh: Accessor<number>): MemoryEntryListSelectors => {
		const identity = `${scope.toString()}|${query.toString()}|${refresh.toString()}`;
		const existingSelectors = memoryListSelectors.get(identity);
		if (existingSelectors) return existingSelectors;
		const currentKey = createMemo(() => listKey(scope(), query().trim()));
		const currentState = createMemo(() => memoryLists()[currentKey()] ?? EMPTY_MEMORY_LIST);
		createEffect(() => { void refresh(); void reloadMemoryList(scope(), query().trim()); });
		const selectors: MemoryEntryListSelectors = {
			entries: createMemo(() => currentState().entries), loading: createMemo(() => currentState().loading),
			excluded: (entryId) => createMemo(() => currentState().excludedIds.has(entryId)),
			error: createMemo(() => currentState().error), feedback: createMemo(() => currentState().feedback),
			busyId: createMemo(() => currentState().busyId), editingEntryId: createMemo(() => currentState().editingEntryId),
			editedEntryText: createMemo(() => currentState().editedEntryText), excludedIds: createMemo(() => currentState().excludedIds),
			setEditedEntryText: (value) => patchMemoryList(currentKey(), { editedEntryText: value }),
			startEditing: (entry) => patchMemoryList(currentKey(), { editingEntryId: entry.id, editedEntryText: entry.text }),
			cancelEditing: () => patchMemoryList(currentKey(), { editingEntryId: null }),
			forget: (entry, success) => {
				const api = companion.memory;
				if (!api?.forget) return;
				const key = currentKey();
				patchMemoryList(key, { busyId: entry.id, error: null, feedback: null });
				void Promise.resolve()
					.then(() => api.forget(entry.id))
					.then(() => {
						patchMemoryList(key, { feedback: success });
						return reloadMemoryList(scope(), query().trim());
					})
					.catch((error) => patchMemoryList(key, { error: messageOf(error) }))
					.finally(() => patchMemoryList(key, { busyId: null }));
			},
			toggleExclude: (entry, included, excluded) => {
				const api = companion.memory;
				if (!api?.exclude) return;
				const key = currentKey();
				const next = !currentState().excludedIds.has(entry.id);
				patchMemoryList(key, { busyId: entry.id, error: null, feedback: null });
				void Promise.resolve()
					.then(() => api.exclude(entry.id, next))
					.then(() => {
						const ids = new Set(currentState().excludedIds);
						if (next) ids.add(entry.id); else ids.delete(entry.id);
						patchMemoryList(key, { excludedIds: ids, feedback: next ? excluded : included });
					})
					.catch((error) => patchMemoryList(key, { error: messageOf(error) }))
					.finally(() => patchMemoryList(key, { busyId: null }));
			},
			saveEdit: (entry, success) => {
				const api = companion.memory;
				const key = currentKey();
				const text = currentState().editedEntryText.trim();
				if (!text || !api?.edit) return;
				patchMemoryList(key, { busyId: entry.id, error: null, feedback: null });
				void Promise.resolve()
					.then(() => api.edit(entry.id, text))
					.then(() => reloadMemoryList(scope(), query().trim()))
					.then(() => patchMemoryList(key, { feedback: success, editingEntryId: null }))
					.catch((error) => patchMemoryList(key, { error: messageOf(error) }))
					.finally(() => patchMemoryList(key, { busyId: null }));
			},
		};
		memoryListSelectors.set(identity, selectors);
		return selectors;
	};

	const [candidateValues, setCandidateValues] = createSignal<Record<string, CandidateState>>({});
	const [memoryCandidatesState, setMemoryCandidatesState] = createSignal<MemoryCandidate[]>([]);
	const [memoryCandidatesLoadingState, setMemoryCandidatesLoadingState] = createSignal(false);
	const [memoryCandidatesErrorState, setMemoryCandidatesErrorState] = createSignal<string | null>(null);
	let candidatesRequestSeq = 0;
	let candidatesRequested = false;
	const loadCandidates = async (): Promise<void> => {
		const seq = ++candidatesRequestSeq;
		setMemoryCandidatesLoadingState(true);
		setMemoryCandidatesErrorState(null);
		const api = companion.memory;
		if (!api?.listCandidates) {
			setMemoryCandidatesLoadingState(false);
			return;
		}
		try {
			const candidates = await api.listCandidates();
			if (seq === candidatesRequestSeq) setMemoryCandidatesState(candidates);
		} catch (error) {
			if (seq === candidatesRequestSeq) setMemoryCandidatesErrorState(messageOf(error));
		} finally {
			if (seq === candidatesRequestSeq) setMemoryCandidatesLoadingState(false);
		}
	};
	const ensureCandidatesLoaded = (): void => {
		if (candidatesRequested) return;
		candidatesRequested = true;
		void loadCandidates();
	};
	const memoryCandidates = createMemo(() => {
		ensureCandidatesLoaded();
		return memoryCandidatesState();
	});
	const memoryCandidatesLoading = createMemo(() => {
		ensureCandidatesLoaded();
		return memoryCandidatesLoadingState();
	});
	const memoryCandidatesError = createMemo(() => {
		ensureCandidatesLoaded();
		return memoryCandidatesErrorState();
	});
	const candidateSelectors = new Map<string, MemoryCandidateSelectors>();
	const memoryCandidate = (candidate: Accessor<MemoryCandidate>): MemoryCandidateSelectors => {
		const id = candidate().id;
		const existingSelector = candidateSelectors.get(id);
		if (existingSelector) return existingSelector;
		const state = createMemo(() => candidateValues()[id] ?? { editedText: candidate().normalizedText, decidedScope: candidate().suggestedScope, busy: false, error: null });
		const ensureState = (): CandidateState => candidateValues()[id] ?? { editedText: candidate().normalizedText, decidedScope: candidate().suggestedScope, busy: false, error: null };
		const update = (patch: Partial<CandidateState>): void => {
			setCandidateValues((current) => ({ ...current, [id]: { ...ensureState(), ...patch } }));
		};
		const selectors: MemoryCandidateSelectors = {
			editedText: createMemo(() => state().editedText), decidedScope: createMemo(() => state().decidedScope),
			busy: createMemo(() => state().busy), error: createMemo(() => state().error),
			setEditedText: (value) => update({ editedText: value }),
			setDecidedScope: (value) => update({ decidedScope: value }),
			approve: () => {
				const api = companion.memory;
				if (!api?.approveCandidate) return;
				const current = ensureState(); update({ busy: true, error: null });
				const text = current.editedText.trim(); const edited = text && text !== candidate().normalizedText ? text : undefined;
				void Promise.resolve()
					.then(() => api.approveCandidate(id, edited, current.decidedScope))
					.catch((error) => update({ error: messageOf(error) }))
					.finally(() => update({ busy: false }));
			},
			reject: () => {
				const api = companion.memory;
				if (!api?.rejectCandidate) return;
				update({ busy: true, error: null });
				void Promise.resolve()
					.then(() => api.rejectCandidate(id))
					.catch((error) => update({ error: messageOf(error) }))
					.finally(() => update({ busy: false }));
			},
		};
		candidateSelectors.set(id, selectors);
		return selectors;
	};

	const roleplay = (): RoleplaySelectors => {
		const visibleVariables = createMemo(() => companion.character?.roleplay.variables.filter((variable) => variable.display.kind !== "hidden") ?? []);
		const unlocked = createMemo(() => new Set(companion.roleplay?.unlocked ?? []));
		const collections = createMemo(() => companion.character?.roleplay.unlockables.filter((entry) => unlocked().has(entry.id)) ?? []);
		const mediaById = createMemo(() => new Map((companion.character?.roleplay.media ?? []).map((media) => [media.id, media])));
		const mediaSelectors = new Map<string | undefined, Accessor<CharacterDisplay["roleplay"]["media"][number] | undefined>>();
		const mediaFor = (id: string | undefined) => {
			const existing = mediaSelectors.get(id); if (existing) return existing;
			const selector = createMemo(() => (id === undefined ? undefined : mediaById().get(id)));
			mediaSelectors.set(id, selector); return selector;
		};
		const displaySelectors = new Map<string, Accessor<string>>();
		const displayValue = (variable: CharacterDisplay["roleplay"]["variables"][number]) => {
			const existing = displaySelectors.get(variable.id); if (existing) return existing;
			const selector = createMemo(() => {
				const value = companion.roleplay?.values[variable.id] ?? variable.initial;
				if (variable.display.kind !== "level" || typeof value !== "number") return String(value);
				return [...variable.display.levels].sort((left, right) => right.min - left.min).find((level) => value >= level.min)?.label ?? String(value);
			});
			displaySelectors.set(variable.id, selector); return selector;
		};
		const selectors = { visibleVariables, collections, mediaFor, displayValue };
		return selectors;
	};

	const store: BackstageWorkflowStore = {
		selectedTab, setSelectedTab: (value) => { if (value === "roles" || value === "memory" || value === "studio" || value === "relationship") setSelectedTabState(value); },
		syncInitialTab: (value) => setSelectedTabState(value === "settings" ? "roles" : value ?? "roles"), roleBusyId, importing, roleFeedback,
		importPackage: (files, done, failed) => {
			const api = companion.characters;
			if (files.length === 0 || !api?.import) return;
			setImporting(true); setRoleFeedback(undefined);
			void Promise.all(files.map(async (file) => {
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
				return { path: file.webkitRelativePath || file.name, base64: btoa(binary) };
			}))
				.then((payload) => api.import(payload))
				.then(() => setRoleFeedback(done))
				.catch((error) => setRoleFeedback(`${failed}${messageOf(error)}`))
				.finally(() => setImporting(false));
		},
		characters: createMemo(() => {
			const values = companion.characters?.characters?.() ?? [];
			for (const character of values) void loadTrust(character.id);
			return values;
		}),
		pluginTrust: (id) => createMemo(() => trustById()[id]),
		pluginTrustLoading: (id) => createMemo(() => trustLoadingById()[id] ?? false),
		confirmingPlugins: (id) => createMemo(() => confirmingById()[id] ?? false),
		setConfirmingPlugins: (id, value) => setConfirmingById((current) => ({ ...current, [id]: value })),
		enablePlugins: (id) => {
			const api = companion.characters;
			if (!api?.confirmPluginTrust) return;
			setRoleBusyId(id);
			void Promise.resolve()
				.then(() => api.confirmPluginTrust(id))
				.then(() => loadTrust(id, true))
				.then(() => setConfirmingById((current) => ({ ...current, [id]: false })))
				.finally(() => setRoleBusyId(undefined));
		},
		activateRole: (id) => {
			const api = companion.characters;
			if (!api?.activate) return;
			setRoleBusyId(id);
			void Promise.resolve().then(() => api.activate(id)).finally(() => setRoleBusyId(undefined));
		},
		canon: createCanonSelectors,
		relationshipEnabled, historyReadEnabled, settingsAvailable, relationshipSaving, relationshipFeedback, relationshipError,
		toggleRelationshipMemory: (enabledLabel, disabledLabel, genericError) => {
			const api = companion.settings;
			if (!api?.set) return;
			setRelationshipSaving(true); setRelationshipFeedback(undefined); setRelationshipError(undefined);
			const next = !relationshipEnabled();
			void Promise.resolve()
				.then(() => api.set({ relationshipMemoryEnabled: next }))
				.then(() => setRelationshipFeedback(next ? enabledLabel : disabledLabel))
				.catch(() => setRelationshipError(genericError))
				.finally(() => setRelationshipSaving(false));
		},
		toggleHistoryRead: (genericError) => {
			const api = companion.settings;
			if (!api?.set) return;
			setRelationshipSaving(true); setRelationshipFeedback(undefined); setRelationshipError(undefined);
			void Promise.resolve()
				.then(() => api.set({ conversationHistoryReadEnabled: !historyReadEnabled() }))
				.catch(() => setRelationshipError(genericError))
				.finally(() => setRelationshipSaving(false));
		},
		roleplay, memoryScope, memoryQueryText, memoryQuery, memoryRefreshKey, memoryScopeTabs: memoryScopeTabSelector,
		setMemoryQueryText, submitMemorySearch, clearMemorySearch, changeMemoryScope, memoryEntryList, memoryCandidates, memoryCandidatesLoading, memoryCandidatesError, memoryCandidate,
	};
	WORKFLOW_STORES.set(companion, store);
	return store;
}
