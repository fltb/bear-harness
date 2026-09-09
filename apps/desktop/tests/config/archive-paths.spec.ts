// @vitest-environment node

import { describe, expect, it } from "vitest";
import { normalizeArchivePath } from "../../scripts/archive-paths.mjs";

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
