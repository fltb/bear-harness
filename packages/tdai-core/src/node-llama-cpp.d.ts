/**
 * Compile-time shape for the dynamically loaded local embedding integration.
 *
 * The runtime implementation is loaded dynamically by embedding.ts, so this
 * declaration keeps the native module out of the host-neutral module graph.
 */
declare module "node-llama-cpp" {
	export const getLlama: (options: {
		logLevel: number;
		gpu?: "auto" | "metal" | "cuda" | "vulkan" | false;
		build?: "never";
		skipDownload?: boolean;
		usePrebuiltBinaries?: boolean;
		progressLogs?: boolean;
	}) => Promise<unknown>;
	export const resolveModelFile: (
		model: string,
		options?: {
			directory?: string;
			cli?: boolean;
			endpoints?: { huggingFace?: string };
			signal?: AbortSignal;
			onProgress?: (progress: { downloadedSize: number; totalSize: number }) => void;
			deleteTempFileOnCancel?: boolean;
		},
	) => Promise<string>;
	export const LlamaLogLevel: { readonly error: number };
}
