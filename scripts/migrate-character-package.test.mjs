import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { migratePackage } from "./migrate-character-package.mjs";

const legacy = `format_version: 1
id: test-role
name: Test
language: en-US
behavior:
  identity:
    summary: A test character.
  agency:
    never: [Invent results.]
    when_uncertain: [Ask for details.]
system_prompt: Follow the role instructions.
`;

test("one-way conversion preserves the source and reference text and refuses overwrite", async () => {
	const root = mkdtempSync(join(tmpdir(), "bear-convert-"));
	try {
		const source = join(root, "old");
		const destination = join(root, "test-role");
		mkdirSync(join(source, "canon"), { recursive: true });
		writeFileSync(join(source, "character.yaml"), legacy);
		writeFileSync(join(source, "canon", "notes.txt"), "The bell rings at dawn.");
		writeFileSync(
			join(source, "canon", "manifest.yaml"),
			"sources:\n  - id: bell\n    path: notes.txt\n    title: Bell notes\nentities: []\nmodules: []\n",
		);
		const receipt = await migratePackage(source, destination);
		const manifest = parse(readFileSync(join(destination, "character.yaml"), "utf8"));
		assert.equal(manifest.format_version, 2);
		assert.equal(manifest.behavior.agency, undefined);
		assert.match(
			manifest.system_prompt,
			/Follow the role instructions\.[\s\S]*Invent results\.[\s\S]*Ask for details\./,
		);
		assert.equal(readFileSync(join(source, "character.yaml"), "utf8"), legacy);
		assert.equal(
			readFileSync(join(source, "canon", "notes.txt"), "utf8"),
			"The bell rings at dawn.",
		);
		assert.equal(
			readFileSync(join(destination, "canon", "notes.txt"), "utf8"),
			"# Bell notes\n\nThe bell rings at dawn.",
		);
		assert.equal(existsSync(join(destination, "canon", "manifest.yaml")), false);
		assert.equal(receipt.retired.canon.sources[0].id, "bell");
		assert.equal(receipt.sourceFiles.length, 3);
		assert.equal(existsSync(`${destination}.migration.json`), true);
		await assert.rejects(migratePackage(source, destination), /already exists/);
		await assert.rejects(migratePackage(source, join(source, "..nested")), /outside/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed validation and symlink sources never publish a partial package", async () => {
	const root = mkdtempSync(join(tmpdir(), "bear-convert-invalid-"));
	try {
		const source = join(root, "old");
		const destination = join(root, "test-role");
		mkdirSync(source);
		writeFileSync(
			join(source, "character.yaml"),
			`${legacy}\nvisual:\n  avatar: assets/missing.png\n`,
		);
		await assert.rejects(migratePackage(source, destination));
		assert.equal(existsSync(destination), false);
		assert.equal(existsSync(`${destination}.migration.json`), false);
		symlinkSync(join(source, "character.yaml"), join(source, "linked.yaml"));
		await assert.rejects(migratePackage(source, destination), /symlinks/);
		assert.equal(existsSync(destination), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
