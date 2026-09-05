import { type Accessor, createMemo, createSignal } from "solid-js";
import { createStableSnapshot } from "../lib/stable-snapshot.js";
import type {
	CanonChunk,
	CanonModuleKind,
	CharacterDisplay,
	CharacterSummary,
	CompanionStore,
} from "./companion.js";

export type BackstageTab = "roles" | "canon";
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

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
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

export interface BackstageWorkflowStore {
	selectedTab: Accessor<BackstageTab>;
	setSelectedTab(value: string): void;
	syncInitialTab(value: "roles" | "settings" | undefined): void;
	roleBusyId: Accessor<string | undefined>;
	importing: Accessor<boolean>;
	roleFeedback: Accessor<string | undefined>;
	importPackage(files: File[], done: string, failed: string): void;
	rejectPackageImport(failed: string): void;
	characters: Accessor<CharacterSummary[]>;
	pluginTrust(id: string): Accessor<PluginTrust | undefined>;
	pluginTrustLoading(id: string): Accessor<boolean>;
	confirmingPlugins(id: string): Accessor<boolean>;
	setConfirmingPlugins(id: string, value: boolean): void;
	enablePlugins(id: string): void;
	activateRole(id: string): void;
	canon(
		noParentTitle: Accessor<string>,
		kindLabel: (kind: CanonModuleKind) => string,
	): CanonWorkflowSelectors;
	relationshipEnabled: Accessor<boolean>;
	settingsAvailable: Accessor<boolean>;
	selectedPackageId: Accessor<string | undefined>;
	selectedPackage: Accessor<import("./ipc.js").CharacterPackageDocument | undefined>;
	selectedPackageLoading: Accessor<boolean>;
	selectedPackageError: Accessor<string | undefined>;
	selectPackage(id: string, confirmDiscard: () => boolean): void;
	packageDeleted(id: string): void;
	savePackage(
		yaml: string,
		expectedSha256: string,
	): Promise<import("./ipc.js").CharacterPackageDocument>;
}

const WORKFLOW_STORES = new WeakMap<CompanionStore, BackstageWorkflowStore>();

export function createBackstageWorkflowStore(companion: CompanionStore): BackstageWorkflowStore {
	const existing = WORKFLOW_STORES.get(companion);
	if (existing) return existing;

	const [selectedTab, setSelectedTabState] = createSignal<BackstageTab>("roles");
	const [roleBusyId, setRoleBusyId] = createSignal<string>();
	const [importing, setImporting] = createSignal(false);
	const [roleFeedback, setRoleFeedback] = createSignal<string>();
	const [confirmingById, setConfirmingById] = createSignal<Record<string, boolean>>({});
	const [chosenPackageId, setSelectedPackageId] = createSignal<string>();
	const selectedPackageId = createMemo(
		() =>
			chosenPackageId() ??
			companion.characters?.characters?.().find((item) => item.active)?.id ??
			companion.characters?.characters?.()[0]?.id,
	);
	const packageQuery = companion.characters.observePackage(selectedPackageId);
	const selectedPackage = () => packageQuery.data()?.package;
	const selectedPackageLoading = packageQuery.loading;
	const selectedPackageError = () =>
		packageQuery.error() ? messageOf(packageQuery.error()) : undefined;

	const settingsData = createMemo(() => companion.settings?.data?.());
	const relationshipEnabled = createMemo(() => settingsData()?.relationshipMemoryEnabled ?? false);
	const settingsAvailable = createMemo(() => settingsData() !== undefined);

	const [canonSourceName, setCanonSourceName] = createSignal("");
	const [canonSourceText, setCanonSourceText] = createSignal("");
	const [canonQuery, setCanonQuery] = createSignal("");
	const [submittedCanonQuery, setSubmittedCanonQuery] = createSignal("");
	const canonResults = () =>
		submittedCanonQuery() ? companion.canon.searchResults(submittedCanonQuery()) : [];
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
	const createCanonSelectors = (
		noParentTitle: Accessor<string>,
		kindLabel: (kind: CanonModuleKind) => string,
	): CanonWorkflowSelectors => {
		ensureCanonLoaded();
		const existingSelectors = canonSelectors.get(noParentTitle.toString());
		if (existingSelectors) return existingSelectors;
		const moduleKinds = createMemo(() => CANON_KINDS.map((id) => ({ id, label: kindLabel(id) })));
		const parentModules = createStableSnapshot(() => [
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
			...(companion.canon?.modules?.() ?? []).filter(
				(module) => module.id !== canonEditingModuleId(),
			),
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
					.then(() => {
						if (seq === canonSearchSeq) setSubmittedCanonQuery(query);
					});
			},
			toggleChunk: (chunkId, checked) =>
				setCanonSelectedChunks((current) =>
					checked
						? current.includes(chunkId)
							? current
							: [...current, chunkId]
						: current.filter((id) => id !== chunkId),
				),
			saveModule: () => {
				const title = canonModuleTitle().trim();
				const api = companion.canon;
				if (!title || !api?.upsertModule) return;
				setCanonBusy(true);
				void Promise.resolve()
					.then(() =>
						api.upsertModule({
							...(canonEditingModuleId() ? { id: canonEditingModuleId() } : {}),
							...(canonModuleParentId() ? { parentId: canonModuleParentId() } : {}),
							kind: canonModuleKind(),
							title,
							instructions: canonModuleInstructions().trim(),
							sourceChunkIds: canonSelectedChunks(),
						}),
					)
					.then(() => selectors.clearModuleForm())
					.finally(() => setCanonBusy(false));
			},
			editModule: (module) => {
				setCanonEditingModuleId(module.id);
				setCanonModuleParentId(module.parentId ?? "");
				setCanonModuleKind(module.kind);
				setCanonModuleTitle(module.title);
				setCanonModuleInstructions(module.instructions);
				setCanonSelectedChunks(module.sourceChunkIds);
			},
			deleteModule: (moduleId) => {
				const api = companion.canon;
				if (api?.deleteModule) void Promise.resolve().then(() => api.deleteModule(moduleId));
			},
			clearModuleForm: () => {
				setCanonModuleTitle("");
				setCanonModuleInstructions("");
				setCanonModuleKind("arc");
				setCanonModuleParentId("");
				setCanonEditingModuleId(undefined);
				setCanonSelectedChunks([]);
			},
		};
		canonSelectors.set(noParentTitle.toString(), selectors);
		return selectors;
	};

	const store: BackstageWorkflowStore = {
		selectedTab,
		setSelectedTab: (value) => {
			if (value === "roles" || value === "canon") setSelectedTabState(value);
		},
		syncInitialTab: (value) =>
			setSelectedTabState(value === "settings" ? "roles" : (value ?? "roles")),
		roleBusyId,
		importing,
		roleFeedback,
		importPackage: (files, done, failed) => {
			const api = companion.characters;
			if (files.length === 0 || !api?.import) return;
			setImporting(true);
			setRoleFeedback(undefined);
			void Promise.all(
				files.map(async (file) => {
					const bytes = new Uint8Array(await file.arrayBuffer());
					let binary = "";
					for (let offset = 0; offset < bytes.length; offset += 32_768)
						binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
					return { path: file.webkitRelativePath || file.name, base64: btoa(binary) };
				}),
			)
				.then((payload) => api.import(payload))
				.then(() => setRoleFeedback(done))
				.catch((error) => setRoleFeedback(`${failed}${messageOf(error)}`))
				.finally(() => setImporting(false));
		},
		rejectPackageImport: (failed) => setRoleFeedback(failed),
		characters: createMemo(() => companion.characters?.characters?.() ?? []),
		pluginTrust: (id) => {
			const query = companion.characters.observeTrust(() => id);
			return () => query.data()?.trust;
		},
		pluginTrustLoading: (id) => () => companion.characters.pluginTrustData(id) === undefined,

		confirmingPlugins: (id) => createMemo(() => confirmingById()[id] ?? false),
		setConfirmingPlugins: (id, value) =>
			setConfirmingById((current) => ({ ...current, [id]: value })),
		enablePlugins: (id) => {
			const api = companion.characters;
			if (!api?.confirmPluginTrust) return;
			setRoleBusyId(id);
			void Promise.resolve()
				.then(() => api.confirmPluginTrust(id))
				.then(() => api.pluginTrust(id))
				.then(() => setConfirmingById((current) => ({ ...current, [id]: false })))
				.finally(() => setRoleBusyId(undefined));
		},
		activateRole: (id) => {
			const api = companion.characters;
			if (!api?.activate) return;
			setRoleBusyId(id);
			void Promise.resolve()
				.then(() => api.activate(id))
				.finally(() => setRoleBusyId(undefined));
		},
		selectedPackageId,
		selectedPackage,
		selectedPackageLoading,
		selectedPackageError,
		selectPackage: (id, confirmDiscard) => {
			if (id !== selectedPackageId() && confirmDiscard()) setSelectedPackageId(id);
		},
		packageDeleted: (id) => {
			if (id === selectedPackageId()) setSelectedPackageId(undefined);
		},
		savePackage: async (yaml, expectedSha256) => {
			const current = selectedPackage();
			if (!current) throw new Error("character_package_not_loaded");
			const next = await companion.characters.packageUpdate(
				current.characterId,
				yaml,
				expectedSha256,
			);
			return next;
		},
		canon: createCanonSelectors,
		relationshipEnabled,
		settingsAvailable,
	};
	WORKFLOW_STORES.set(companion, store);
	return store;
}
