import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit/contract test runner for desktop-native code.
 *
 * - Only desktop-native suites run here: product-config validation and the
 *   Electron diagnostics wiring. Host-runtime and companion-ui suites live in
 *   their respective packages.
 * - All retained suites run in a pure Node environment; no renderer plugins,
 *   jsdom, or product-config defines are needed.
 * - Coverage (v8) reports to `coverage/desktop` under the repository root,
 *   restricted to the desktop-only Electron wiring module.
 */

export default defineConfig({
	test: {
		environment: "node",
		include: [
			"tests/config/**/*.spec.ts",
			"tests/diagnostics/electron-wiring.spec.ts",
			"tests/ipc-router.spec.ts",
			"tests/artifact-protocol.spec.ts",
			"tests/update-service.spec.ts",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html", "lcov"],
			reportsDirectory: fileURLToPath(new URL("../../coverage/desktop", import.meta.url)),
			include: ["src/main/diagnostics/electron.ts", "src/main/ipc-router.ts"],
			thresholds: {
				lines: 80,
				statements: 80,
				functions: 80,
				branches: 70,
			},
		},
	},
});
