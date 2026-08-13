import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Opt-in config for the packaged-app smoke (test:e2e:packaged). The default
 * playwright.config.ts deliberately excludes packaged.spec.ts.
 */
export default defineConfig({
	testDir: "./e2e",
	testMatch: /packaged\.spec\.ts/,
	timeout: 90_000,
	workers: 1,
	reporter: [["list"]],
	outputDir: resolve(here, "../../test-results"),
	forbidOnly: true,
	retries: 0,
});
