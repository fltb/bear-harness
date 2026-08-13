/**
 * Renderer-facing global declarations: the compile-time injected product
 * config and the preload bridge surface. Type-only; no runtime code.
 */

import type { ProductConfig } from "../../product.config";

declare global {
	const __PRODUCT_CONFIG__: Readonly<ProductConfig>;

	interface Window {
		bearDesktop: Readonly<{
			platform: "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32";
			diagnostics: Readonly<{
				reportRendererFault(input: unknown): void;
			}>;
		}>;
	}
}
