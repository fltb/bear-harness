import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePackagedBinary } from "../../scripts/packaged-binary.mjs";

describe("packaged smoke binary selection", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-package-selection-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});
	function binary(path: string, contents = "binary") {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, contents);
		return target;
	}
	const macBinary = "Bear.app/Contents/MacOS/bear";
	it("selects ARM64 with a stale Intel package and prefix lookalikes present", () => {
		binary(`mac/${macBinary}`);
		binary(`mac-arm64-old/${macBinary}`);
		const expected = binary(`mac-arm64/${macBinary}`);
		expect(resolvePackagedBinary(root, "darwin", "arm64", "bear")).toBe(expected);
	});
	it("does not fall back to Intel when ARM64 is missing", () => {
		binary(`mac/${macBinary}`);
		expect(() => resolvePackagedBinary(root, "darwin", "arm64", "bear")).toThrow("found 0");
	});
	it.each(["mac", "mac-x64"])("supports Intel output %s without selecting ARM64", (directory) => {
		binary(`mac-arm64/${macBinary}`);
		const expected = binary(`${directory}/${macBinary}`);
		expect(resolvePackagedBinary(root, "darwin", "x64", "bear")).toBe(expected);
	});
	it("rejects ambiguous Intel outputs", () => {
		binary(`mac/${macBinary}`);
		binary(`mac-x64/${macBinary}`);
		expect(() => resolvePackagedBinary(root, "darwin", "x64", "bear")).toThrow("found 2");
	});
	it.each([
		["win32", "win", "bear.exe"],
		["linux", "linux", "bear"],
	])("selects exact %s x64 output", (platform, prefix, executable) => {
		binary(`${prefix}-arm64-unpacked/${executable}`);
		const expected = binary(`${prefix}-unpacked/${executable}`);
		expect(resolvePackagedBinary(root, platform, "x64", "bear")).toBe(expected);
	});
	it("rejects unsupported targets instead of treating them as Linux", () => {
		expect(() => resolvePackagedBinary(root, "freebsd", "x64", "bear")).toThrow("Unsupported");
	});
	it("rejects multiple app bundles", () => {
		binary(`mac-arm64/${macBinary}`);
		binary("mac-arm64/Other.app/Contents/MacOS/bear");
		expect(() => resolvePackagedBinary(root, "darwin", "arm64", "bear")).toThrow(
			"exactly one .app",
		);
	});
	it("rejects missing and empty binaries", () => {
		binary("mac-arm64/Bear.app/Contents/MacOS/other");
		expect(() => resolvePackagedBinary(root, "darwin", "arm64", "bear")).toThrow("missing");
		binary(`mac-arm64/${macBinary}`, "");
		expect(() => resolvePackagedBinary(root, "darwin", "arm64", "bear")).toThrow("non-empty file");
	});
});
