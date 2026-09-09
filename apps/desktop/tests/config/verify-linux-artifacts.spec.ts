// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertDebArchitecture, assertElfX64 } from "../../scripts/verify-linux-artifacts.mjs";

function elf(machine: number): Buffer {
	const bytes = Buffer.alloc(64);
	bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
	bytes.writeUInt16LE(machine, 18);
	return bytes;
}

describe("verify-linux-artifacts", () => {
	it("accepts exact amd64 DEB metadata", () => {
		expect(() => assertDebArchitecture("amd64\n")).not.toThrow();
	});

	it("rejects a non-amd64 DEB", () => {
		expect(() => assertDebArchitecture("arm64\n")).toThrow("expected amd64");
	});

	it("accepts a 64-bit little-endian x86-64 ELF", () => {
		expect(() => assertElfX64(elf(0x3e), "AppImage")).not.toThrow();
	});

	it("rejects an arm64 ELF", () => {
		expect(() => assertElfX64(elf(0xb7), "AppImage")).toThrow("expected x86-64");
	});

	it("rejects input that is not an ELF executable", () => {
		expect(() => assertElfX64(Buffer.alloc(64), "AppImage")).toThrow("not an ELF");
	});

	it("keeps the workflow verification free of pipefail-sensitive probes", () => {
		const workflow = readFileSync(
			join(import.meta.dirname, "../../../../.github/workflows/ci.yml"),
			"utf8",
		);
		expect(workflow).toContain("node apps/desktop/scripts/verify-linux-artifacts.mjs");
		expect(workflow).not.toContain('dpkg-deb --info "$DEB" | grep -q');
		expect(workflow).not.toContain('"$APPIMAGE" --appimage-extract');
	});
});
