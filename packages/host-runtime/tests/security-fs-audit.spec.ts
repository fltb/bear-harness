// @vitest-environment node

import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FsAuditHit, installFsAudit } from "../src/security/fs-audit.js";

const handles: Array<{ uninstall(): void }> = [];

function audit(roots: string[], onHit?: (hit: FsAuditHit) => void) {
	const handle = installFsAudit({ auditRoots: roots, onHit });
	handles.push(handle);
	return handle;
}

afterEach(() => {
	// Reverse order: the last install is the active singleton; a stale handle's
	// uninstall is a no-op while another is active.
	for (const handle of handles.splice(0).reverse()) handle.uninstall();
});

describe("installFsAudit", () => {
	it("warns and records deletes inside an audited root", () => {
		const root = mkdtempSync(join(tmpdir(), "fs-protect-"));
		const target = join(root, "inside.txt");
		writeFileSync(target, "x");
		const hits: FsAuditHit[] = [];
		const warns: string[] = [];
		const handle = installFsAudit({
			auditRoots: [root],
			logger: { warn: (m) => warns.push(m) },
			onHit: (hit) => hits.push(hit),
		});
		handles.push(handle);
		// singleton: a second install returns the same handle (no double wrap)
		expect(installFsAudit({ auditRoots: [root] })).toBe(handle);

		fs.unlinkSync(target); // delete goes through — sentinel only warns
		expect(fs.existsSync(target)).toBe(false);
		expect(hits).toEqual([{ root, target, operation: "unlink" }]);
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("[fs-audit] delete");
		expect(warns[0]).toContain(root);
		rmSync(root, { recursive: true, force: true });
	});

	it("covers rmdirSync and the promises API with the right operations", async () => {
		const root = mkdtempSync(join(tmpdir(), "fs-protect-"));
		const dir = join(root, "subdir");
		fs.mkdirSync(dir);
		const hits: FsAuditHit[] = [];
		audit([root], (hit) => hits.push(hit));

		fs.rmdirSync(dir);
		expect(hits.map((h) => h.operation)).toEqual(["rmdir"]);

		const recursive = join(root, "recursive");
		fs.mkdirSync(recursive, { recursive: true });
		await fs.promises.rm(recursive, { recursive: true });
		// Node's recursive `rm` removes children, then calls `rmdir` on the
		// directory itself — the sentinel sees every delete, including that
		// internal one.
		expect(hits.map((h) => h.operation)).toEqual(["rmdir", "rm", "rmdir"]);
		expect(fs.existsSync(recursive)).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	it("lets deletes outside the protected roots pass through untouched", () => {
		const root = mkdtempSync(join(tmpdir(), "fs-protect-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "fs-protect-out-"));
		const outside = join(outsideDir, "file.txt");
		writeFileSync(outside, "x");
		const hits: FsAuditHit[] = [];
		audit([root], (hit) => hits.push(hit));

		fs.unlinkSync(outside);
		expect(fs.existsSync(outside)).toBe(false);
		expect(hits).toEqual([]);
		rmSync(root, { recursive: true, force: true });
		rmSync(outsideDir, { recursive: true, force: true });
	});

	it("does not confuse prefix siblings with protected roots", () => {
		const base = mkdtempSync(join(tmpdir(), "fs-protect-"));
		const root = join(base, "data");
		const sibling = join(base, "data-other");
		fs.mkdirSync(root, { recursive: true });
		fs.mkdirSync(sibling, { recursive: true });
		const hits: FsAuditHit[] = [];
		audit([root], (hit) => hits.push(hit));

		const outside = join(sibling, "file.txt");
		writeFileSync(outside, "x");
		fs.unlinkSync(outside);
		expect(hits).toEqual([]);
		rmSync(base, { recursive: true, force: true });
	});

	it("uninstall restores the original fs functions", () => {
		const root = mkdtempSync(join(tmpdir(), "fs-protect-"));
		const originalUnlinkSync = fs.unlinkSync;
		const originalPromisesRm = fs.promises.rm;
		const handle = audit([root]);
		expect(fs.unlinkSync).not.toBe(originalUnlinkSync);
		expect(fs.promises.rm).not.toBe(originalPromisesRm);

		handle.uninstall();
		expect(fs.unlinkSync).toBe(originalUnlinkSync);
		expect(fs.promises.rm).toBe(originalPromisesRm);

		// after restore: no sentinel fires
		const target = join(root, "after.txt");
		writeFileSync(target, "x");
		let hits = 0;
		const second = installFsAudit({ auditRoots: [root], onHit: () => (hits += 1) });
		expect(second).not.toBe(handle);
		fs.unlinkSync(target);
		expect(hits).toBe(1);
		second.uninstall();
		rmSync(root, { recursive: true, force: true });
	});

	it("is idempotent: a second install returns the same handle and never double-wraps", () => {
		const root = mkdtempSync(join(tmpdir(), "fs-protect-"));
		let hits = 0;
		const first = installFsAudit({ auditRoots: [root], onHit: () => (hits += 1) });
		handles.push(first);
		const second = installFsAudit({ auditRoots: [root], onHit: () => (hits += 1) });
		expect(second).toBe(first);
		const third = installFsAudit({ auditRoots: [root] });
		expect(third).toBe(first);

		const target = join(root, "once.txt");
		writeFileSync(target, "x");
		fs.unlinkSync(target);
		expect(hits).toBe(1); // a double wrap would fire the sentinel twice
		rmSync(root, { recursive: true, force: true });
	});
});
