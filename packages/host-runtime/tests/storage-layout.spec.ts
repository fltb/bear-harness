// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeLayout, requireCompanionId } from "../src/storage/layout.js";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "bear-runtime-layout-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("runtime physical layout", () => {
	it("places every character-owned path below exactly one companion directory", () => {
		const dataRoot = root();
		const layout = new RuntimeLayout(dataRoot);
		const role = layout.ensureCompanionDirectories("jizhou");

		expect(layout.systemDatabase).toBe(join(dataRoot, "system", "settings.db"));
		expect(layout.characterPackage("jizhou")).toBe(join(dataRoot, "characters", "jizhou"));
		expect(role).toMatchObject({
			root: join(dataRoot, "companions", "jizhou"),
			database: join(dataRoot, "companions", "jizhou", "runtime.db"),
			sessions: join(dataRoot, "companions", "jizhou", "sessions"),
			explicitMemory: join(dataRoot, "companions", "jizhou", "memory", "MEMORY.md"),
			tdaiMemory: join(dataRoot, "companions", "jizhou", "memory", "tdai"),
			runs: join(dataRoot, "companions", "jizhou", "runs"),
			artifacts: join(dataRoot, "companions", "jizhou", "artifacts"),
			audit: join(dataRoot, "companions", "jizhou", "audit"),
			diagnostics: join(dataRoot, "companions", "jizhou", "diagnostics"),
		});
	});

	it("rejects path traversal and non-component ids", () => {
		for (const value of ["", ".", "..", "../role", "role/name", "/role", "role name"]) {
			expect(() => requireCompanionId(value), value).toThrow(/safe path component/);
		}
		expect(requireCompanionId("role_01-alpha")).toBe("role_01-alpha");
	});

	it("rejects a symlink used as a managed directory", () => {
		const dataRoot = root();
		const outside = root();
		mkdirSync(join(dataRoot, "system"));
		symlinkSync(outside, join(dataRoot, "companions"));

		expect(() => new RuntimeLayout(dataRoot).ensureSystemDirectories()).toThrow(/real directory/);
	});

	it("requires an absolute data root", () => {
		expect(() => new RuntimeLayout(join("relative", dirname("data")))).toThrow(/absolute/);
	});
});
