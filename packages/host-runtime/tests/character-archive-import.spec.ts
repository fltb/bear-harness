// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterArchiveImport } from "../src/companion/character-archive-import.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), "bear-archive-test-"));
	roots.push(root);
	const archive = new CharacterArchiveImport(root, (directory) => {
		const files: Record<string, string> = {};
		function visit(dir: string) {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) visit(path);
				else files[relative(directory, path)] = readFileSync(path).toString("base64");
			}
		}
		visit(directory);
		return files;
	});
	return { root, archive };
}
async function upload(bytes: Uint8Array) {
	const { archive, root } = setup();
	const { uploadId } = archive.begin();
	archive.append(uploadId, 0, Buffer.from(bytes).toString("base64"));
	try {
		return await archive.finish(uploadId);
	} finally {
		expect(readdirSync(root)).toEqual([]);
		await archive.close();
	}
}
describe("Host streaming ZIP imports", () => {
	it("streams uploaded chunks and preserves decoded files", async () => {
		const { archive } = setup();
		const { uploadId } = archive.begin();
		const zip = zipSync({
			"role/character.yaml": strToU8("id: role"),
			"role/assets/raw.bin": new Uint8Array([0, 255, 128]),
		});
		archive.append(uploadId, 0, Buffer.from(zip.subarray(0, 20)).toString("base64"));
		expect(() => archive.append(uploadId, 0, "AA==")).toThrow("character_import_upload_invalid");
		archive.append(uploadId, 20, Buffer.from(zip.subarray(20)).toString("base64"));
		expect(await archive.finish(uploadId)).toEqual({
			"role/character.yaml": Buffer.from("id: role").toString("base64"),
			"role/assets/raw.bin": "AP+A",
		});
		await archive.close();
	});
	it.each(["../escape", "/absolute", "role/../../escape", "C:/escape", "role\\escape"])(
		"rejects unsafe path %s",
		async (path) => {
			await expect(upload(zipSync({ [path]: strToU8("bad") }))).rejects.toThrow();
		},
	);
	it("rejects symlinks", async () => {
		const zip = zipSync({ "role/link": strToU8("../../secret") });
		const view = new DataView(zip.buffer);
		view.setUint32(view.getUint32(zip.length - 6, true) + 38, 0xa1ff0000, true);
		await expect(upload(zip)).rejects.toThrow();
	});
	it("rejects CRC corruption", async () => {
		const zip = zipSync({ "character.yaml": strToU8("id: role") }, { level: 0 });
		zip[44] ^= 1;
		await expect(upload(zip)).rejects.toThrow("character_archive_crc_invalid");
	});
	it("cancels abandoned uploads and disposes resources on close", async () => {
		const { archive, root } = setup();
		const one = archive.begin();
		archive.append(one.uploadId, 0, "AA==");
		archive.cancel(one.uploadId);
		expect(readdirSync(root)).toEqual([]);
		const two = archive.begin();
		archive.append(two.uploadId, 0, "AA==");
		await archive.close();
		expect(() => archive.begin()).toThrow("character_import_closed");
	});
});
