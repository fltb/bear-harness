/**
 * Companion UI package entry.
 *
 * Supported public surface:
 * - `CompanionApp` — the app shell, taking `{ product, client }`; it
 *   creates a client-bound companion store and composes the full UI.
 * - `createCompanionStore` / `DesktopProvider` / `useCompanionStore` — the
 *   reactive store facade and its context wiring.
 * - Wire model types, narrow guards and normalizers (re-exported through the
 *   store), plus the supplementary API interfaces consumed by the sheets.
 * - `installRendererFaultReporting(reporter?)` — metadata-only fault
 *   reporting with an optional reporter callback.
 *
 * `CompanionClient` is imported type-only from `@bear-harness/companion-types`;
 * it mirrors the preload `companion` facade (one async `Promise<unknown>`
 * function per IPC channel, envelope-unwrapped by `invoke`). Stores treat it
 * as required, but keep runtime guards so an absent client degrades like a
 * missing bridge: empty data, presence `idle`.
 */

export type { BrandLicense, ProductConfig } from "@bear-harness/product-config";
export { CompanionApp } from "./App.js";
export {
	installRendererFaultReporting,
	type RendererErrorType,
	type RendererFault,
	type RendererFaultReporter,
} from "./diagnostics.js";
export * from "./stores/companion.js";
