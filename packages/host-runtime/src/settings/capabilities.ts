import type {
	LocalEmbeddingCandidate,
	MemoryVectorPresetCapability,
	MemoryVectorProviderCapability,
	NetworkProxyModeCapability,
} from "@bear-harness/protocol";

export type HostLocalEmbeddingCandidate = LocalEmbeddingCandidate & {
	readonly modelPath?: string;
};

export type HostSettingsCapabilities = {
	readonly networkProxyModes: readonly NetworkProxyModeCapability[];
	readonly memoryVectorProviders: readonly MemoryVectorProviderCapability[];
	readonly memoryVectorPresets: readonly MemoryVectorPresetCapability[];
	readonly localEmbeddingCandidates: readonly HostLocalEmbeddingCandidate[];
};

const immutable = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

/** Immutable Host-owned catalog for every settings option exposed to the UI. */
export const HOST_SETTINGS_CAPABILITIES: HostSettingsCapabilities = Object.freeze({
	networkProxyModes: Object.freeze([
		immutable({ id: "direct" as const }),
		immutable({ id: "auto" as const }),
		immutable({ id: "manual" as const }),
	]),
	memoryVectorProviders: Object.freeze([
		immutable({ id: "none" as const, onboarding: true }),
		immutable({ id: "remote" as const, onboarding: false }),
		immutable({ id: "local" as const, onboarding: true }),
	]),
	memoryVectorPresets: Object.freeze([
		immutable({ id: "bge-m3", model: "BAAI/bge-m3", dimensions: 1024 }),
		immutable({
			id: "qwen3-embedding",
			model: "Qwen/Qwen3-Embedding-8B",
			dimensions: 1024,
		}),
		immutable({ id: "tongyi-v4", model: "text-embedding-v4", dimensions: 1024 }),
		immutable({ id: "openai-3-small", model: "text-embedding-3-small", dimensions: 1536 }),
	]),
	localEmbeddingCandidates: Object.freeze([
		immutable({ id: "embeddinggemma", name: "EmbeddingGemma", isDefault: true }),
		immutable({
			id: "bge-base-zh",
			name: "BGE Small Chinese",
			modelPath: "hf:CompendiumLabs/bge-small-zh-v1.5-gguf/bge-small-zh-v1.5-q8_0.gguf",
			isDefault: false,
		}),
		immutable({
			id: "multilingual-e5",
			name: "Multilingual E5 Base",
			modelPath: "hf:dinab/multilingual-e5-base-Q8_0-GGUF/multilingual-e5-base-q8_0.gguf",
			isDefault: false,
		}),
	]),
});

export function findHostLocalEmbeddingCandidate(
	id: string,
): HostLocalEmbeddingCandidate | undefined {
	return HOST_SETTINGS_CAPABILITIES.localEmbeddingCandidates.find((candidate) => candidate.id === id);
}
