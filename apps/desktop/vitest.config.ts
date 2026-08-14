import { fileURLToPath } from "node:url";
import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { productConfig } from "./product.config.ts";

/**
 * Unit/contract test runner.
 *
 * - Renderer tests run in jsdom with vite-plugin-solid and the Solid testing
 *   library; main diagnostics tests opt into a pure Node environment with a
 *   `// @vitest-environment node` docblock.
 * - Coverage (v8) reports to the repository-root `coverage/` directory and
 *   includes every renderer source file and every diagnostics module — even
 *   those not directly imported by a test — excluding only the renderer entry
 *   and pure type declarations.
 * - Global thresholds: lines/statements/functions >= 80%, branches >= 70%.
 */

export default defineConfig({
	define: {
		__PRODUCT_CONFIG__: JSON.stringify(productConfig),
	},
	plugins: [solidPlugin()],
	test: {
		environment: "jsdom",
		include: ["tests/**/*.spec.{ts,tsx}"],
		setupFiles: ["./tests/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html", "lcov"],
			reportsDirectory: fileURLToPath(new URL("../../coverage", import.meta.url)),
			include: ["src/renderer/**/*.{ts,tsx}", "src/main/diagnostics/**/*.ts"],
			exclude: [
				"src/renderer/index.tsx",
				"src/renderer/**/*.d.ts",
				"src/main/diagnostics/**/*.d.ts",
			],
			thresholds: {
				lines: 80,
				statements: 80,
				functions: 80,
				branches: 70,
			},
		},
	},
});
