// @vitest-environment node

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configureCrashpad } from "../../src/diagnostics/crashpad.js";

describe("configureCrashpad", () => {
	it("creates the per-launch dir, points crashDumps at it and starts with uploads disabled", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-crashpad-"));
		const setPath = vi.fn();
		const start = vi.fn();
		const launchId = "launch-abc";

		const crashDir = configureCrashpad({
			app: { setPath },
			reporter: { start },
			root,
			launchId,
		});

		expect(crashDir).toBe(join(root, "crashes", launchId));
		expect(existsSync(crashDir)).toBe(true);
		expect(setPath).toHaveBeenCalledWith("crashDumps", crashDir);
		expect(start).toHaveBeenCalledTimes(1);
		const options = start.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(options.uploadToServer).toBe(false);
		// No submitURL, no dynamic extra, no attachments/compress/rateLimit.
		expect(options.submitURL).toBeUndefined();
		expect(options.extra).toBeUndefined();
		expect(options.compress).toBeUndefined();
		expect(options.rateLimit).toBeUndefined();
		expect(options.globalExtra).toEqual({ diagnostics_schema: "1", launch_id: launchId });
		rmSync(root, { recursive: true, force: true });
	});

	it("creates the crash dir with 0700 permissions", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-crashpad-"));
		configureCrashpad({
			app: { setPath: vi.fn() },
			reporter: { start: vi.fn() },
			root,
			launchId: "launch-mode",
		});
		const mode = statSync(join(root, "crashes", "launch-mode")).mode & 0o777;
		expect(mode).toBe(0o700);
		rmSync(root, { recursive: true, force: true });
	});
});
