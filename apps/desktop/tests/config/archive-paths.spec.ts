// @vitest-environment node

import { describe, expect, it } from "vitest";
import { normalizeArchivePath, resolveMacOutputDirectory } from "../../scripts/archive-paths.mjs";

describe("normalizeArchivePath", () => {
	it("normalizes Windows ASAR separators and preserves the archive root", () => {
		expect(normalizeArchivePath("\\dist\\main\\index.js")).toBe("/dist/main/index.js");
		expect(normalizeArchivePath("/node_modules\\node-llama-cpp\\package.json")).toBe(
			"/node_modules/node-llama-cpp/package.json",
		);
	});

	it("adds a root separator when an ASAR implementation omits it", () => {
		expect(normalizeArchivePath("dist/main/index.js")).toBe("/dist/main/index.js");
	});

	it("leaves normalized POSIX paths unchanged", () => {
		expect(normalizeArchivePath("/dist/main/index.js")).toBe("/dist/main/index.js");
	});
});

describe("resolveMacOutputDirectory", () => {
	it("accepts the architecture directory used by cross-architecture packaging", () => {
		expect(resolveMacOutputDirectory("/release", "x64", (path) => path.endsWith("mac-x64"))).toBe(
			"/release/mac-x64",
		);
	});

	it("accepts the native directory used on an Intel runner", () => {
		expect(resolveMacOutputDirectory("/release", "x64", (path) => path.endsWith("/mac"))).toBe(
			"/release/mac",
		);
	});

	it("rejects a missing macOS package output", () => {
		expect(() => resolveMacOutputDirectory("/release", "x64", () => false)).toThrow(
			"Packaged macOS directory is missing",
		);
	});
});
