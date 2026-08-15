import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Host unit/contract test runner.
 *
 * - All Host tests run in the default Node environment (each spec also
 *   declares `// @vitest-environment node` explicitly).
 * - Coverage (v8) reports to the repository-root `coverage/host/` directory,
 *   mirroring the per-package coverage split introduced by the monorepo
 *   cutover.
 */

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.spec.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html", "lcov"],
			reportsDirectory: fileURLToPath(new URL("../../coverage/host", import.meta.url)),
		},
	},
});
