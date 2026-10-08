import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import patch from "fast-json-patch";
import { strToU8, zipSync } from "fflate";
import { OfficeParser } from "officeparser";
import PQueue from "p-queue";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { parse, parseDocument, stringify } from "yaml";
import { open } from "yauzl";

const directories: string[] = [];
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "bear-upstream-"));
	directories.push(path);
	return path;
}
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("upstream: structured character data", () => {
	it("round-trips Unicode, multiline prompts, arrays and false values", () => {
		const value = {
			name: "角色",
			system_prompt: "第一行\n第二行\n",
			behavior: { enabled: false, count: 0 },
			tags: ["a", "b"],
		};
		expect(parse(stringify(value))).toEqual(value);
	});
	it("rejects duplicate YAML keys", () => {
		expect(() => parse("name: a\nname: b")).toThrow();
	});
	it("reports YAML syntax locations for editor diagnostics", () => {
		const doc = parseDocument("name: [broken");
		expect(doc.errors.length).toBeGreaterThan(0);
		expect(doc.errors[0]?.linePos?.[0]).toMatchObject({ line: 1 });
	});
	it("preserves comments during document edits", () => {
		const doc = parseDocument("# author note\nname: old\n");
		doc.set("name", "new");
		expect(doc.toString()).toContain("# author note");
		expect(parse(doc.toString())).toEqual({ name: "new" });
	});
	it("validates JSON Schema 2020-12 nested required fields", () => {
		const validate = new Ajv2020({ strict: false }).compile({
			type: "object",
			properties: {
				relation: {
					type: "object",
					properties: { score: { type: "integer", minimum: 0 } },
					required: ["score"],
					additionalProperties: false,
				},
			},
			required: ["relation"],
		});
		expect(validate({ relation: { score: 1 } })).toBe(true);
		expect(validate({ relation: { score: -1 } })).toBe(false);
		expect(validate.errors?.[0]?.instancePath).toBe("/relation/score");
	});
	it("uses local schema references without external fetches", () => {
		const validate = new Ajv2020().compile({
			$defs: { label: { type: "string", minLength: 1 } },
			$ref: "#/$defs/label",
		});
		expect(validate("present")).toBe(true);
		expect(validate("")).toBe(false);
	});
	it("applies escaped JSON pointers without mutating the source", () => {
		const input = { "a/b": { "~name": "old" } };
		const output = patch.applyPatch(
			input,
			[{ op: "replace", path: "/a~1b/~0name", value: "new" }],
			true,
			false,
		).newDocument;
		expect(output).toEqual({ "a/b": { "~name": "new" } });
		expect(input["a/b"]["~name"]).toBe("old");
	});
	it("rejects prototype mutation through a JSON patch", () => {
		expect(() =>
			patch.applyPatch({}, [{ op: "add", path: "/__proto__/polluted", value: true }], true),
		).toThrow();
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	});
});

describe("upstream: concurrency and persistence", () => {
	it("serializes work and continues after a rejected task", async () => {
		const queue = new PQueue({ concurrency: 1 });
		const entered: number[] = [];
		const release = Promise.withResolvers<void>();
		const first = queue.add(async () => {
			entered.push(1);
			await release.promise;
			throw new Error("fixture failure");
		});
		const failed = expect(first).rejects.toThrow("fixture failure");
		const second = queue.add(async () => {
			entered.push(2);
			return 42;
		});
		expect(entered).toEqual([1]);
		release.resolve();
		await failed;
		expect(await second).toBe(42);
		await queue.onIdle();
		expect(queue.pending).toBe(0);
	});
	it("removes aborted queued work without executing it", async () => {
		const queue = new PQueue({ concurrency: 1 });
		queue.pause();
		const controller = new AbortController();
		let ran = false;
		const result = queue.add(
			() => {
				ran = true;
			},
			{ signal: controller.signal },
		);
		controller.abort();
		queue.start();
		await expect(result).rejects.toThrow();
		await queue.onIdle();
		expect(ran).toBe(false);
	});
	it("excludes competing file writers and permits acquisition after release", async () => {
		const path = join(await directory(), "MEMORY.md");
		await writeFile(path, "before");
		const release = await lockfile.lock(path, { retries: 0 });
		try {
			await expect(lockfile.lock(path, { retries: 0 })).rejects.toMatchObject({ code: "ELOCKED" });
			await writeFile(path, "after");
		} finally {
			await release();
		}
		const again = await lockfile.lock(path, { retries: 0 });
		await again();
		expect(await readFile(path, "utf8")).toBe("after");
	});
});

describe("upstream: archive and actual document parsing", () => {
	it("reads Unicode ZIP filenames and bytes through the real reader", async () => {
		const path = join(await directory(), "character.zip");
		await writeFile(path, zipSync({ "canon/资料.md": strToU8("角色知识") }));
		const contents = await new Promise<Record<string, string>>((resolve, reject) =>
			open(path, { lazyEntries: true }, (error, archive) => {
				if (error || !archive) {
					reject(error);
					return;
				}
				const files: Record<string, string> = {};
				archive.on("error", reject);
				archive.on("end", () => resolve(files));
				archive.on("entry", (entry) =>
					archive.openReadStream(entry, (readError, stream) => {
						if (readError || !stream) {
							archive.close();
							reject(readError);
							return;
						}
						const chunks: Buffer[] = [];
						stream.on("data", (chunk) => chunks.push(chunk));
						stream.on("error", reject);
						stream.on("end", () => {
							files[entry.fileName] = Buffer.concat(chunks).toString();
							archive.readEntry();
						});
					}),
				);
				archive.readEntry();
			}),
		);
		expect(contents).toEqual({ "canon/资料.md": "角色知识" });
	});
	it("parses a real DOCX document into text", async () => {
		const path = join(await directory(), "reference.docx");
		await writeFile(
			path,
			zipSync({
				"[Content_Types].xml": strToU8(
					'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
				),
				"word/document.xml": strToU8(
					'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>角色参考事实</w:t></w:r></w:p></w:body></w:document>',
				),
			}),
		);
		const result = await OfficeParser.parseOffice(path, { outputErrorToConsole: false });
		expect(String((await result.to("md")).value)).toContain("角色参考事实");
	});
	it("rejects corrupt document bytes", async () => {
		const path = join(await directory(), "broken.docx");
		await writeFile(path, "not a zip");
		await expect(OfficeParser.parseOffice(path, { outputErrorToConsole: false })).rejects.toThrow();
	});
});
