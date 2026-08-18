import { fileURLToPath } from "node:url";
import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/**
 * Companion UI unit/contract test runner.
 *
 * - Renderer tests run in jsdom with vite-plugin-solid and the Solid
 *   testing library; diagnostics and shell behavior are covered here too.
 * - Coverage (v8) reports to the repository-root `coverage/ui/` directory,
 *   matching the per-package `coverage/<package>` artifact convention.
 */
export default defineConfig({
	plugins: [solidPlugin()],
	test: {
		environment: "jsdom",
		include: ["tests/**/*.spec.{ts,tsx}"],
		setupFiles: ["./tests/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html", "lcov"],
			reportsDirectory: fileURLToPath(new URL("../../coverage/ui", import.meta.url)),
			include: ["src/**/*.{ts,tsx}"],
			exclude: ["src/**/*.d.ts", "src/features/NetworkAndMemorySettings.tsx"],
			thresholds: {
				statements: 80,
				branches: 70,
				functions: 80,
				lines: 80,
			},
		},
	},
});
