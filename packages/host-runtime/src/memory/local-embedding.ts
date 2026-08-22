export type LocalEmbeddingCandidate = {
	readonly id: string;
	readonly name: string;
	readonly modelPath?: string;
	readonly isDefault: boolean;
};

/** The only local embedding models this Host can configure. */
export const LOCAL_EMBEDDING_CANDIDATES: readonly LocalEmbeddingCandidate[] = [
	{ id: "embeddinggemma", name: "EmbeddingGemma", isDefault: true },
	{
		id: "bge-base-zh",
		name: "BGE Small Chinese",
		modelPath: "hf:CompendiumLabs/bge-small-zh-v1.5-gguf/bge-small-zh-v1.5-q8_0.gguf",
		isDefault: false,
	},
	{
		id: "multilingual-e5",
		name: "Multilingual E5 Base",
		modelPath: "hf:dinab/multilingual-e5-base-Q8_0-GGUF/multilingual-e5-base-q8_0.gguf",
		isDefault: false,
	},
] as const;

export function findLocalEmbeddingCandidate(id: string): LocalEmbeddingCandidate | undefined {
	return LOCAL_EMBEDDING_CANDIDATES.find((candidate) => candidate.id === id);
}
