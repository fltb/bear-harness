import type { LocalEmbeddingAcquisitionState } from "@bear-harness/protocol";
import type { Accessor } from "solid-js";
import type {
	ArtifactActionResponse,
	ArtifactIdentity,
	ArtifactReadRequest,
	ArtifactReadResponse,
	CanonChunk,
	CanonModule,
	CanonModuleKind,
	CanonSource,
	CharacterDeletionStatus,
	CharacterDraft,
	CharacterDraftFiles,
	CharacterDraftRevision,
	CharacterListData,
	CharacterPackageDeleteResponse,
	CharacterPackageDocument,
	CharacterRuntimeDeleteResponse,
	CharacterSummary,
	ConfiguredModel,
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

export type EmbeddingSettingsValue =
	| NonNullable<SettingsPatch["memoryVectorService"]>
	| SettingsData["modelDownloadSource"];
export type LocalEmbeddingTargetValue =
	| { kind: "candidate"; candidateId: string }
	| { kind: "custom"; customPath: string; dimensions: number };
export type ModelDownloadSourceValue =
	| { type: "official" }
	| { type: "hf-mirror" }
	| { type: "custom"; endpoint: string };
export interface LocalEmbeddingInventoryData {
	candidates: Array<{
		id: string;
		name: string;
		dimensions: number;
		isDefault: boolean;
		target: LocalEmbeddingTargetValue;
		installed: boolean;
	}>;
	activeTarget?: LocalEmbeddingTargetValue;
}
export type CompleteEmbeddingValue =
	| { choice: "none" }
	| { choice: "local"; target: LocalEmbeddingTargetValue }
	| {
			choice: "remote";
			configuration: {
				baseUrl: string;
				model: string;
				dimensions: number;
				apiKey?: string;
			};
	  };
interface RpcQueryBinding<T> {
	readonly data: T | undefined;
	readonly isPending: boolean;
	readonly error: unknown;
}
interface RpcMutationBinding<T, TResult = unknown> {
	readonly mutateAsync: (variables: T) => Promise<TResult>;
	readonly isPending: boolean;
	readonly error: unknown;
	readonly isSuccess: boolean;
}
export interface QueryView<T> {
	data(): T | undefined;
	loading(): boolean;
	error(): unknown;
}
export interface EmbeddingBinding {
	acquisitionState(): LocalEmbeddingAcquisitionState;
	cancelAcquisition(): Promise<LocalEmbeddingAcquisitionState>;
	readonly settingsQuery: RpcQueryBinding<{ settings: SettingsData }>;
	readonly capabilitiesQuery: RpcQueryBinding<SettingsCapabilities>;
	readonly inventoryQuery: RpcQueryBinding<LocalEmbeddingInventoryData>;
	readonly acquisitionQuery: RpcQueryBinding<LocalEmbeddingAcquisitionState>;
	readonly settingsMutation: RpcMutationBinding<EmbeddingSettingsValue>;
	readonly acquisitionStartMutation: RpcMutationBinding<
		{ target: LocalEmbeddingTargetValue; source: ModelDownloadSourceValue },
		LocalEmbeddingAcquisitionState
	>;
	readonly activateLocalMutation: RpcMutationBinding<
		LocalEmbeddingTargetValue,
		{ settings: SettingsData }
	>;
	readonly completeEmbeddingMutation: RpcMutationBinding<
		CompleteEmbeddingValue,
		{ settings: SettingsData }
	>;
}

export interface SettingsApi {
	data(): SettingsData | undefined;
	get(): Promise<SettingsData>;
	set(settings: SettingsPatch): Promise<void>;
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
	setSystemDefaults(
		reply: { providerId: string; modelId: string },
		vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } },
	): Promise<void>;
	initializeDefaults(): Promise<void>;
	completeDefaultsOnboarding(): Promise<void>;
	completeSystemOnboarding(
		reply: { providerId: string; modelId: string },
		vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } },
	): Promise<void>;
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

export interface ArtifactApi {
	read(request: ArtifactReadRequest): Promise<ArtifactReadResponse>;
	open(identity: ArtifactIdentity): Promise<ArtifactActionResponse>;
	reveal(identity: ArtifactIdentity): Promise<ArtifactActionResponse>;
	saveAs(identity: ArtifactIdentity): Promise<ArtifactActionResponse>;
}

export interface ExternalAgentApi {
	status(): Promise<import("./ipc.js").ExternalAgentStatusData>;
	discover(): Promise<import("./ipc.js").ExternalAgentCandidate[]>;
	connect(params: { canonicalPath: string; version: string; sha256: string }): Promise<void>;
}

export interface CharacterApi {
	observeTrust(
		characterId: Accessor<string>,
	): QueryView<{ trust: Awaited<ReturnType<CharacterApi["pluginTrust"]>> }>;
	observePackage(
		characterId: Accessor<string | undefined>,
	): QueryView<{ package: CharacterPackageDocument }>;
	observeDeletionStatus(
		characterId: Accessor<string | undefined>,
	): QueryView<{ status: CharacterDeletionStatus }>;
	packageData(characterId: string): CharacterPackageDocument | undefined;
	deletionStatusData(characterId: string): CharacterDeletionStatus | undefined;
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
	packageReveal(characterId: string): Promise<void>;
	deletionStatus(characterId: string): Promise<CharacterDeletionStatus>;
	runtimeDelete(characterId: string): Promise<CharacterRuntimeDeleteResponse>;
	packageDelete(characterId: string): Promise<CharacterPackageDeleteResponse>;
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
