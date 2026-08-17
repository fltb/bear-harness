import { existsSync } from "node:fs";
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

export default defineConfig({
	testDir: "./e2e",
	timeout: 30_000,
	workers: 1,
	reporter: [["list"]],
	outputDir: resolve(here, "../../test-results/web-dev"),
	forbidOnly: true,
	retries: 0,
	use: {
		baseURL,
	},
	webServer: [
		{
			command: "npm run dev --workspace @bear-harness/web-dev",
			env: {
				BEAR_WEB_DEV_PORT: webPort,
				BEAR_WEB_DEV_HOST_PORT: hostPort,
				BEAR_WEB_DEV_DATA_DIR: resolve(here, `../../test-results/web-dev-data-${process.pid}`),
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
