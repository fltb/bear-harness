import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoEnv = resolve(here, "../../.env");
if (existsSync(repoEnv)) process.loadEnvFile(repoEnv);

export default defineConfig({
	testDir: "./e2e",
	timeout: 30_000,
	workers: 1,
	reporter: [["list"]],
	outputDir: resolve(here, "../../test-results/web-dev"),
	forbidOnly: true,
	retries: 0,
	use: {
		baseURL: "http://127.0.0.1:3200",
	},
	webServer: {
		command: "npm run dev --workspace @bear-harness/web-dev",
		env: {
			BEAR_WEB_DEV_PORT: "3200",
			BEAR_WEB_DEV_HOST_PORT: "3201",
			BEAR_WEB_DEV_DATA_DIR: resolve(here, `../../test-results/web-dev-data-${process.pid}`),
			BEAR_WEB_DEV_DEBUG: "1",
			BEAR_E2E_RULE_PROVIDER: "1",
		},
		url: "http://127.0.0.1:3200",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
