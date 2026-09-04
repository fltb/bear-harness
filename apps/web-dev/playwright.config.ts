import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoEnv = resolve(here, "../../.env");
if (existsSync(repoEnv)) process.loadEnvFile(repoEnv);
const webPort = process.env.BEAR_E2E_WEB_PORT ?? "3200";
const hostPort = process.env.BEAR_E2E_HOST_PORT ?? "3201";
const providerPort = process.env.BEAR_E2E_PROVIDER_PORT ?? "3211";
const baseURL = `http://127.0.0.1:${webPort}`;
const dataScope = `${process.pid}-${randomUUID()}`;
// Keep mutable Run roots outside the repository. The source ACP bootstrap lives
// at the repository root, which the native sandbox mounts read-only so its
// package imports remain available. Nesting outputs beneath that same root
// would correctly fail the read/write overlap check before the agent starts.
const dataDirectory = resolve(realpathSync.native(tmpdir()), `bear-harness-web-dev-${dataScope}`);
const piWorkerPath = realpathSync.native(
	fileURLToPath(new URL("../../pi-e2e-worker.mjs", import.meta.url)),
);
const cleanupPolicy = process.env.BEAR_WEB_DEV_DATA_CLEANUP ?? "success";
const lastRunFile = resolve(here, "../../test-results/web-dev/.last-run.json");
process.env.BEAR_WEB_DEV_DATA_DIR = dataDirectory;
process.env.BEAR_WEB_DEV_DATA_SCOPE = dataScope;
process.env.BEAR_WEB_DEV_DATA_CLEANUP = cleanupPolicy;
process.env.BEAR_WEB_DEV_LAST_RUN_FILE = lastRunFile;

export default defineConfig({
	globalTeardown: "./e2e/helpers.ts",
	testDir: "./e2e",
	timeout: 30_000,
	workers: 1,
	reporter: [["list"]],
	outputDir: resolve(here, "../../test-results/web-dev"),
	snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
	forbidOnly: true,
	retries: 0,
	expect: {
		toHaveScreenshot: {
			animations: "disabled",
			maxDiffPixelRatio: 0.01,
		},
	},
	use: {
		baseURL,
		// Exercise the complete Chromium browser in its background headless mode.
		// The reduced headless-shell binary has a reproducible renderer SIGTRAP on
		// longer native-model journeys and is less representative of production.
		channel: "chromium",
		colorScheme: "dark",
	},
	webServer: [
		{
			command: "npm run dev --workspace @bear-harness/web-dev",
			env: {
				BEAR_WEB_DEV_PORT: webPort,
				BEAR_WEB_DEV_HOST_PORT: hostPort,
				BEAR_WEB_DEV_DATA_DIR: dataDirectory,
				BEAR_WEB_DEV_DATA_SCOPE: dataScope,
				BEAR_WEB_DEV_DATA_CLEANUP: cleanupPolicy,
				BEAR_WEB_DEV_LAST_RUN_FILE: lastRunFile,
				BEAR_WEB_DEV_PI_WORKER_PATH: piWorkerPath,
				BEAR_WEB_DEV_DEBUG: "1",
				BEAR_CUSTOM_PROVIDER_ID: "",
				BEAR_CUSTOM_PROVIDER_NAME: "",
				BEAR_CUSTOM_BASE_URL: "",
				BEAR_CUSTOM_MODEL_ID: "",
				BEAR_CUSTOM_API_KEY: "",
			},
			url: baseURL,
			reuseExistingServer: false,
			timeout: 30_000,
			gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
		},
		{
			command: "node e2e/rule-provider-server.ts",
			env: { BEAR_E2E_PROVIDER_PORT: providerPort },
			url: `http://127.0.0.1:${providerPort}/health`,
			reuseExistingServer: false,
			timeout: 30_000,
		},
	],
});
