import { describe, expect, it, vi } from "vitest";
import { packageMacWithRecovery } from "../../scripts/package-mac.mjs";

const success = { code: 0, signal: null, output: "ok" };
const busy = (message: string) => ({
	code: 1,
	signal: null,
	output: `DMGError: Unable to detach device cleanly: hdiutil: couldn't unmount "disk4" - ${message}`,
});

describe("macOS packaging recovery", () => {
	it("runs successful builds only once", async () => {
		const run = vi.fn().mockResolvedValue(success);
		expect(await packageMacWithRecovery(run, vi.fn())).toBe(success);
		expect(run).toHaveBeenCalledTimes(1);
	});
	it.each(["Resource busy", "资源忙"])(
		"rebuilds once for a confirmed transient detach error: %s",
		async (message) => {
			const run = vi.fn().mockResolvedValueOnce(busy(message)).mockResolvedValueOnce(success);
			const report = vi.fn();
			expect(await packageMacWithRecovery(run, report)).toBe(success);
			expect(run).toHaveBeenCalledTimes(2);
			expect(report).toHaveBeenCalledTimes(1);
		},
	);
	it("preserves failure after the bounded retry", async () => {
		const failure = busy("Resource busy");
		const run = vi.fn().mockResolvedValue(failure);
		expect(await packageMacWithRecovery(run, vi.fn())).toBe(failure);
		expect(run).toHaveBeenCalledTimes(2);
	});
	it.each([
		{ code: 1, signal: null, output: "build failed" },
		{ code: 1, signal: null, output: "Resource busy" },
		busy("Permission denied"),
		{ ...busy("Resource busy"), code: null, signal: "SIGTERM" },
	])("does not retry unrelated errors or interruption", async (failure) => {
		const run = vi.fn().mockResolvedValue(failure);
		expect(await packageMacWithRecovery(run, vi.fn())).toBe(failure);
		expect(run).toHaveBeenCalledTimes(1);
	});
});
