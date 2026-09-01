import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Source E2E config: app, diagnostics, and attachment-agent journeys run by
 * default. packaged.spec.ts is opt-in via `test:e2e:packaged` (it launches a
 * real packaged binary located by resolve-packaged-binary.mjs).
 */
export default defineConfig({
	testDir: "./e2e",
	testMatch: /(app|diagnostics|attachment-agent|recovery)\.spec\.ts/,
	timeout: 90_000,
	workers: 1,
	reporter: [["list"]],
	outputDir: resolve(here, "../../test-results"),
	forbidOnly: true,
	retries: 0,
});
