import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "playwright/test";
import { launchSourceApp } from "./helpers";

const SENTINEL = "SENTINEL-对话内容-Prompt-路径-栈帧-请勿落盘";

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
