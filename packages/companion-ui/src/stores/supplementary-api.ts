import type {
	EmbeddingDownloadState,
	MemoryCandidate as MemoryCandidateSchema,
} from "@bear-harness/protocol/schema";
import type { z } from "@bear-harness/schema";
import type { Accessor } from "solid-js";
import type {
	CanonChunk,
	CanonModule,
	CanonModuleKind,
	CanonSource,
	CharacterDraft,
	CharacterDraftFiles,
	CharacterDraftRevision,
	CharacterListData,
	CharacterPackageDocument,
	CharacterSummary,
	ConfiguredModel,
	MemoryCaptureResponse,
	MemoryEntry,
	MemoryListRequest,
	MemoryScope,
	ModelListData,
	OnboardingData,
	ProviderInfo,
	ProviderListData,
	ProviderLoginResult,
	RunInfo,
	RunListData,
	RunPermissionRequest,
	SettingsCapabilities,
	SettingsData,
	SettingsPatch,
	Snapshot,
} from "./ipc.js";

type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type EmbeddingSettingsValue =
	| SettingsData["memoryVectorService"]
	| SettingsData["modelDownloadSource"];
interface RpcQueryBinding<T> {
	readonly data: T | undefined;
	readonly isPending: boolean;
	readonly error: unknown;
}
interface RpcMutationBinding<T> {
	readonly mutateAsync: (variables: T) => Promise<unknown>;
	readonly isPending: boolean;
	readonly error: unknown;
	readonly isSuccess: boolean;
}
export interface EmbeddingBinding {
	downloadState(): EmbeddingDownloadState;
	cancelDownload(): Promise<unknown>;
	readonly settingsQuery: RpcQueryBinding<{ settings: SettingsData }>;
	readonly capabilitiesQuery: RpcQueryBinding<SettingsCapabilities>;
	readonly settingsMutation: RpcMutationBinding<EmbeddingSettingsValue>;
	readonly localConfigureMutation: RpcMutationBinding<{
		provider: "none" | "local";
		candidateId?: string;
		customPath?: string;
	}>;
}

export interface QueryView<T> {
	data(): T | undefined;
	loading(): boolean;
	error(): unknown;
}

export interface MemoryApi {
	observeList(
		scope: Accessor<MemoryScope>,
		query: Accessor<string>,
		characterId?: Accessor<string | undefined>,
	): QueryView<{ entries: MemoryEntry[] }>;
	observeCandidates(
		characterId: Accessor<string | undefined>,
		status?: MemoryCandidate["status"],
	): QueryView<{ candidates: MemoryCandidate[] }>;
	listState(
		scope?: MemoryScope,
		query?: string,
		characterId?: string,
	): { entries: MemoryEntry[]; loading: boolean; error: string | null };
	candidateState(
		status?: MemoryCandidate["status"],
		characterId?: string,
	): { candidates: MemoryCandidate[]; loading: boolean; error: string | null };
	entries(): MemoryEntry[] | undefined;
	revision(): number;
	search(query: string, scope?: MemoryScope, characterId?: string): Promise<MemoryEntry[]>;
	list(params?: MemoryListRequest): Promise<MemoryEntry[]>;
	capture(entryId: string): Promise<MemoryCaptureResponse>;
	configureLocalEmbedding(
		provider: "none" | "local",
		candidateId?: string,
		customPath?: string,
	): Promise<{ ready: true }>;
	forget(entryId: string, characterId?: string): Promise<void>;
	edit(entryId: string, newText: string, characterId?: string): Promise<void>;
	exclude(memoryId: string, excluded: boolean, characterId?: string): Promise<void>;
	/** Pending candidates awaiting user confirmation (reactive list). */
	candidates(): MemoryCandidate[] | undefined;
	listCandidates(
		status?: MemoryCandidate["status"],
		characterId?: string,
	): Promise<MemoryCandidate[]>;
	approveCandidate(
		candidateId: string,
		editedText?: string,
		decidedScope?: MemoryScope,
		characterId?: string,
	): Promise<void>;
	rejectCandidate(candidateId: string, characterId?: string): Promise<void>;
}

export interface SettingsApi {
	data(characterId?: string): SettingsData | undefined;
	get(characterId?: string): Promise<SettingsData>;
	set(settings: SettingsPatch, characterId?: string): Promise<void>;
}

export interface ProviderApi {
	loginState(providerId: string): ProviderLoginResult | undefined;
	providers(): ProviderInfo[];
	list(): Promise<ProviderListData>;
	customUpsert(params: {
		providerId: string;
		name: string;
		baseUrl: string;
		models: Array<{ id: string; name?: string; supportsImages?: boolean }>;
		apiKey?: string;
	}): Promise<void>;
	importPiConfig(configJson: string): Promise<ConfiguredModel[]>;
	overrideBaseUrl(params: { providerId: string; baseUrl: string }): Promise<void>;
	setApiKey(providerId: string, apiKey: string, sessionOnly?: boolean): Promise<void>;
	login(providerId: string): Promise<ProviderLoginResult>;
	loginStatus(providerId: string): Promise<ProviderLoginResult>;
	loginAnswer(providerId: string, answer: string): Promise<ProviderLoginResult>;
	loginCancel(providerId: string): Promise<void>;
	logout(providerId: string): Promise<void>;
	remove(providerId: string): Promise<void>;
}

export interface ModelApi {
	data(): ModelListData;
	models(): ConfiguredModel[];
	loading(): boolean;
	error(): unknown;
	refetch(): void;
	list(conversationId?: string): Promise<ModelListData>;
	enable(providerId: string, modelId: string, label?: string): Promise<void>;
	disable(providerId: string, modelId: string): Promise<void>;
	select(conversationId: string, providerId: string, modelId: string): Promise<void>;
	setMultimodalFallback(providerId: string, modelId: string): Promise<void>;
	setDefaultReply(providerId: string, modelId: string): Promise<void>;
	clearDefaultReply(): Promise<void>;
	setVisionAuto(): Promise<void>;
}

export interface RunApi {
	list(): Promise<RunListData>;
	pendingPermissions(): RunPermissionRequest[];
	steer(runId: string, instruction: string): Promise<void>;
	interrupt(runId: string): Promise<RunInfo>;
	resume(runId: string): Promise<RunInfo>;
	cancel(runId: string): Promise<RunInfo>;
	respondPermission(runId: string, requestId: string, optionId: string): Promise<RunInfo>;
}

export interface ExternalAgentApi {
	status(): Promise<import("./ipc.js").ExternalAgentStatusData>;
	discover(): Promise<import("./ipc.js").ExternalAgentCandidate[]>;
	connect(params: {
		canonicalPath: string;
		version: string;
		sha256: string;
		codexHome: string;
	}): Promise<void>;
}

export interface CharacterApi {
	observeTrust(
		characterId: Accessor<string>,
	): QueryView<{ trust: Awaited<ReturnType<CharacterApi["pluginTrust"]>> }>;
	observePackage(
		characterId: Accessor<string | undefined>,
	): QueryView<{ package: CharacterPackageDocument }>;
	packageData(characterId: string): CharacterPackageDocument | undefined;
	pluginTrustData(
		characterId: string,
	): Awaited<ReturnType<CharacterApi["pluginTrust"]>> | undefined;
	characters(): CharacterSummary[];
	list(): Promise<CharacterListData>;
	activate(characterId: string): Promise<void>;
	import(files: Array<{ path: string; base64: string }>): Promise<void>;
	pluginTrust(characterId: string): Promise<{
		origin: "official" | "local" | "imported";
		pluginHash: string;
		trusted: boolean;
		pluginsPresent: boolean;
	}>;

	confirmPluginTrust(characterId: string): Promise<void>;
	packageGet(characterId: string): Promise<CharacterPackageDocument>;
	packageUpdate(
		characterId: string,
		yaml: string,
		expectedSha256: string,
	): Promise<CharacterPackageDocument>;
	draftCreate(params?: { basePackageId?: string; locale?: string }): Promise<CharacterDraft>;
	draftGet(id: string): Promise<CharacterDraft>;
	draftPatch(
		id: string,
		expectedRevision: number,
		files: CharacterDraftFiles,
	): Promise<CharacterDraft>;
	draftUploadAssets(
		id: string,
		expectedRevision: number,
		assets: Array<{ path: string; mime: string; base64: string }>,
	): Promise<CharacterDraft>;
	draftListRevisions(id: string): Promise<CharacterDraftRevision[]>;
	draftRestoreRevision(
		id: string,
		expectedRevision: number,
		sourceRevision: number,
	): Promise<CharacterDraft>;
	draftValidate(id: string, expectedRevision: number): Promise<CharacterDraft>;
	draftPublish(id: string, expectedRevision: number): Promise<CharacterDraft>;
}

export interface CanonApi {
	searchResults(query: string): CanonChunk[];
	sources(): CanonSource[];
	modules(): CanonModule[];
	listSources(): Promise<void>;
	addSource(logicalName: string, content: string): Promise<void>;
	search(query: string): Promise<CanonChunk[]>;
	removeSource(sourceId: string): Promise<void>;
	listModules(): Promise<void>;
	upsertModule(params: {
		id?: string;
		parentId?: string;
		kind: CanonModuleKind;
		title: string;
		instructions: string;
		sourceChunkIds: string[];
	}): Promise<void>;
	deleteModule(id: string): Promise<void>;
}
