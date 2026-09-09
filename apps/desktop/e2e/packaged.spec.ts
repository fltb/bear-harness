import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import { productConfig } from "@bear-harness/product-config";
import { chromium } from "playwright";
import { expect, test } from "playwright/test";
import { assertProductPage, provisionReplyModel } from "./helpers";
import { waitForPackagedRendererPage } from "./packaged-renderer-page.js";

function waitForDevTools(child: ReturnType<typeof spawn>): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(
			() => reject(new Error(`DevTools endpoint not found:\n${output}`)),
			60_000,
		);
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			const endpoint = output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
			if (endpoint) {
				clearTimeout(timeout);
				resolve(endpoint);
			}
		});
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			reject(new Error(`packaged app exited before DevTools was ready (${code ?? signal})`)),
		);
	});
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			child.off("exit", exited);
			resolve(false);
		}, timeoutMs);
		const exited = () => {
			clearTimeout(timeout);
			resolve(true);
		};
		child.once("exit", exited);
	});
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	if (await waitForExit(child, 5_000)) return;
	child.kill("SIGKILL");
	await waitForExit(child, 5_000);
}

/**
 * Packaged-app smoke: launches the real installed binary (located by
 * resolve-packaged-binary.mjs, which sets BEAR_PACKAGED_BINARY) and verifies
 * the configured identity end to end. Never collected by the default
 * testMatch — opt-in via `npm run test:e2e:packaged`.
 */
test("packaged app shows the configured product", async () => {
	test.setTimeout(150_000);
	const binary = process.env.BEAR_PACKAGED_BINARY;
	expect(binary, "BEAR_PACKAGED_BINARY must point at the unpacked app binary").toBeTruthy();
	const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "bear-e2e-packaged-")));

	const child = spawn(
		binary as string,
		[
			...(process.platform === "linux" ? ["--no-sandbox"] : []),
			"--remote-debugging-port=0",
			`--user-data-dir=${join(tempRoot, productConfig.dataDirectoryName)}`,
			"--use-mock-keychain",
			"--disable-gpu",
		],
		{
			env: {
				...process.env,
				HOME: tempRoot,
				APPDATA: tempRoot,
				LOCALAPPDATA: tempRoot,
				XDG_CONFIG_HOME: tempRoot,
				NODE_ENV: "test",
				BEAR_E2E_PACKAGED: "1",
				BEAR_E2E_APP_DATA: tempRoot,
				BEAR_DIAGNOSTICS_ROOT: tempRoot,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
	try {
		browser = await chromium.connectOverCDP(await waitForDevTools(child));
		const context = browser.contexts()[0];
		if (!context) throw new Error("packaged app did not expose a browser context");
		const setupWindow = await waitForPackagedRendererPage(context, 45_000);
		await setupWindow.waitForLoadState("domcontentloaded", { timeout: 45_000 });
		await expect(
			setupWindow.getByRole("dialog", { name: zhCN.modelSetup.dialogLabel }),
		).toBeVisible();
		await provisionReplyModel(setupWindow);
		await assertProductPage(setupWindow, productConfig);

		// Packaged app must load from the asar's file: HTML, never a server.
		expect(setupWindow.url().startsWith("file://")).toBe(true);
	} finally {
		await browser?.close().catch(() => {});
		await stopChild(child);
		rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
