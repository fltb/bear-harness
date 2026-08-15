import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));

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
		url: "http://127.0.0.1:3200",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
