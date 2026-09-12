import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RPC } from "@bear-harness/protocol/schema";
import { expect, test } from "playwright/test";
import { invokeRpc, launchSourceApp } from "./helpers";

const SENTINEL = "SENTINEL-对话内容-Prompt-路径-栈帧-请勿落盘";

test("native diagnostic directory commands use Host-resolved character paths", async () => {
	const { app, tempRoot } = await launchSourceApp({});
	try {
		const window = await app.firstWindow();
		await window.waitForLoadState("domcontentloaded");
		await app.evaluate(({ shell }) => {
			const paths: string[] = [];
			Reflect.set(globalThis, "diagnosticRevealPaths", paths);
			shell.openPath = async (path) => {
				paths.push(path);
				return "";
			};
		});
		const settings = await invokeRpc(window, RPC.diagnostics.get, {});
		expect(settings.canReveal).toBe(true);
		await invokeRpc(window, RPC.diagnostics.reveal, { scope: "character" });
		await invokeRpc(window, RPC.diagnostics.reveal, { scope: "memory" });
		await invokeRpc(window, RPC.diagnostics.reveal, { scope: "system" });
		await invokeRpc(window, RPC.settings.get, {});
		await invokeRpc(window, RPC.diagnostics.reveal, { scope: "latest" });
		const paths = await app.evaluate(
			() => Reflect.get(globalThis, "diagnosticRevealPaths") as string[],
		);
		expect(paths).toHaveLength(4);
		expect(paths.every((path) => path === tempRoot || path.startsWith(`${tempRoot}/`))).toBe(true);
		expect(paths[0]).toMatch(/\/companions\/[^/]+\/diagnostics$/);
		expect(paths[1]).toMatch(/\/companions\/[^/]+\/memory\/tdai$/);
		// Source E2E explicitly sets BEAR_DIAGNOSTICS_ROOT to tempRoot.
		expect(paths[2]).toBe(tempRoot);
		expect(paths[3]).toMatch(/\/companions\/[^/]+\/diagnostics\/traces\/[a-f0-9]{32}$/);
	} finally {
		await app.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

function readAllJsonl(root: string): string {
	const logsDir = join(root, "logs");
	let names: string[];
	try {
		names = readdirSync(logsDir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return "";
	}
	return names
		.sort()
		.map((name) => readFileSync(join(logsDir, name), "utf8"))
		.join("\n");
}

test("renderer faults are recorded as metadata only; crash reports process_gone", async () => {
	const { app: electronApp, tempRoot } = await launchSourceApp({});
	try {
		const window = await electronApp.firstWindow();
		await window.waitForLoadState("domcontentloaded");
		const userData = await electronApp.evaluate(({ app }) => app.getPath("userData"));
		expect(userData.startsWith(tempRoot)).toBe(true);

		// Fail on anything except the one expected pageerror.
		const pageErrors: string[] = [];
		window.on("pageerror", (error) => pageErrors.push(String(error)));
		window.on("console", (message) => {
			if (message.type() !== "error") return;
			// The expected uncaught TypeError surfaces in the console too.
			if (message.text().includes(SENTINEL)) return;
			throw new Error(`unexpected console error: ${message.text()}`);
		});

		// One-time trigger: throw a TypeError carrying the sentinel message.
		await window.evaluate((sentinel) => {
			const onError = () => {
				window.__faultSeen = true;
			};
			window.addEventListener("error", onError, { once: true });
			queueMicrotask(() => {
				throw new TypeError(sentinel);
			});
		}, SENTINEL);
		await window.waitForFunction(() => window.__faultSeen === true);
		expect(pageErrors).toHaveLength(1);

		// Wait for the fault record to hit disk.
		await expect
			.poll(() => readAllJsonl(tempRoot).includes('"name":"renderer.fault"'), { timeout: 20_000 })
			.toBe(true);

		// Crash the renderer and wait for process_gone.
		await electronApp.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
		});
		await expect
			.poll(() => readAllJsonl(tempRoot).includes('"name":"renderer.process_gone"'), {
				timeout: 20_000,
			})
			.toBe(true);

		// The JSONL contains classification metadata only: no sentinel, no
		// URL/path, no message, no stack, no exception fields.
		const text = readAllJsonl(tempRoot);
		expect(text).not.toContain(SENTINEL);
		expect(text).not.toContain("file://");
		expect(text).not.toContain('"message"');
		expect(text).not.toContain('"stack"');
		expect(text).not.toContain('"exception"');
		const faultLine = text.split("\n").find((line) => line.includes('"name":"renderer.fault"'));
		expect(faultLine).toBeDefined();
		expect(faultLine).toContain('"kind":"error"');
		expect(faultLine).toContain('"errorType":"TypeError"');
		expect(faultLine).toContain('"origin":"renderer"');
		expect(pageErrors).toHaveLength(1);
	} finally {
		await electronApp.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
