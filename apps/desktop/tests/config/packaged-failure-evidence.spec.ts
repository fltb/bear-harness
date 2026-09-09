import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectPackagedFailureEvidence,
	collectWindowsApplicationErrors,
} from "../../e2e/packaged-failure-evidence.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collectPackagedFailureEvidence", () => {
	it("returns bounded diagnostic tails and crash dump metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-packaged-evidence-"));
		roots.push(root);
		mkdirSync(join(root, "logs"));
		mkdirSync(join(root, "crashes", "launch"), { recursive: true });
		writeFileSync(
			join(root, "logs", "app.jsonl"),
			`${"x".repeat(200)}\n{"name":"renderer.process_gone","attributes":{"reason":"crashed","exitCode":5}}\n`,
		);
		writeFileSync(join(root, "crashes", "launch", "renderer.dmp"), "dump");

		const evidence = collectPackagedFailureEvidence(root, 180);

		expect(evidence.length).toBeLessThanOrEqual(180);
		expect(evidence).toContain("renderer.process_gone");
		expect(evidence).toContain("renderer.dmp (4 bytes)");
	});

	it("reports when no diagnostic evidence exists", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-packaged-evidence-"));
		roots.push(root);
		expect(collectPackagedFailureEvidence(root)).toBe("no local crash evidence");
	});

	it("collects a bounded Windows Application Error tail without a shell", () => {
		const calls: unknown[][] = [];
		const evidence = collectWindowsApplicationErrors("win32", (command, args) => {
			calls.push([command, args]);
			return { stdout: `${"x".repeat(5000)}\nFaulting module name: renderer.dll` };
		});

		expect(calls).toEqual([
			[
				"wevtutil",
				["qe", "Application", "/q:*[System[(EventID=1000)]]", "/c:8", "/rd:true", "/f:text"],
			],
		]);
		expect(evidence.length).toBeLessThanOrEqual(4_000);
		expect(evidence).toContain("Faulting module name: renderer.dll");
	});

	it("does not query application errors on other platforms", () => {
		let called = false;
		expect(
			collectWindowsApplicationErrors("darwin", () => {
				called = true;
				return {};
			}),
		).toBe("windows application errors unavailable");
		expect(called).toBe(false);
	});
});
