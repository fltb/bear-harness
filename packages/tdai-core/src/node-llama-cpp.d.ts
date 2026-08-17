/**
 * Compile-time shape for the optional local embedding integration.
 *
 * The runtime implementation is loaded dynamically by embedding.ts, so this
 * declaration must not turn node-llama-cpp into a required package dependency.
 */
declare module "node-llama-cpp" {
  export const getLlama: (options: { logLevel: number }) => Promise<unknown>;
  export const resolveModelFile: (model: string, cacheDir?: string) => Promise<string>;
  export const LlamaLogLevel: { readonly error: number };
}
