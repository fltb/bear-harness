// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertWindowsX64Executable } from "../../scripts/verify-windows-pe.mjs";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function peFixture(machine: number) {
	const root = mkdtempSync(join(tmpdir(), "bear-windows-pe-"));
	roots.push(root);
	const executable = join(root, "Bear Harness.exe");
	const bytes = Buffer.alloc(256);
	bytes.write("MZ", 0, "ascii");
	bytes.writeUInt32LE(128, 60);
	bytes.write("PE\0\0", 128, "binary");
	bytes.writeUInt16LE(machine, 132);
	writeFileSync(executable, bytes);
	return executable;
}

describe("Windows PE verification", () => {
	it("accepts an x64 executable", () => {
		expect(() => assertWindowsX64Executable(peFixture(0x8664))).not.toThrow();
	});

	it("rejects a non-x64 executable", () => {
		expect(() => assertWindowsX64Executable(peFixture(0xaa64))).toThrow(
			"expected x64 (0x8664), got 0xaa64",
		);
	});

	it("rejects a corrupt executable", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-windows-pe-"));
		roots.push(root);
		const executable = join(root, "Bear Harness.exe");
		writeFileSync(executable, Buffer.from("not a PE file"));
		expect(() => assertWindowsX64Executable(executable)).toThrow("invalid PE executable");
	});
});
