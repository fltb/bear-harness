// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertNonEmptyNativeBinary,
	nativeBindingBinaryPath,
} from "../../scripts/native-binding-files.mjs";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native binding files", () => {
	it("resolves the binding's actual addon instead of relying on directory size", () => {
		expect(nativeBindingBinaryPath("C:/binding", "win-x64")).toBe(
			join("C:/binding", "bins", "win-x64", "llama-addon.node"),
		);
	});

	it("accepts a non-empty native addon file", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-native-binding-"));
		roots.push(root);
		const binary = join(root, "llama-addon.node");
		writeFileSync(binary, Buffer.from([1]));
		expect(() => assertNonEmptyNativeBinary(binary)).not.toThrow();
	});

	it("rejects both an empty file and a directory", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-native-binding-"));
		roots.push(root);
		const empty = join(root, "empty.node");
		const directory = join(root, "directory.node");
		writeFileSync(empty, Buffer.alloc(0));
		mkdirSync(directory);
		expect(() => assertNonEmptyNativeBinary(empty)).toThrow("empty");
		expect(() => assertNonEmptyNativeBinary(directory)).toThrow("not a file");
	});
});
