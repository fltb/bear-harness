// @vitest-environment node

import { describe, expect, it } from "vitest";
import { CodecRegistry, codecRegistry, guardCell } from "../../src/materials/codec.js";

function parser(kind: string) {
	const value = codecRegistry.getParser(kind);
	if (!value) throw new Error(`missing ${kind} parser`);
	return value;
}

function generator(kind: string) {
	const value = codecRegistry.getGenerator(kind);
	if (!value) throw new Error(`missing ${kind} generator`);
	return value;
}

describe("material codec round trips", () => {
	it("parses text BOM and CSV records without interpreting formulas", async () => {
		await expect(
			parser("text")(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("hello")])),
		).resolves.toEqual({
			text: "hello",
		});
		const csv = await parser("csv")(Buffer.from("name,value\nalpha,1\nbeta,2\n"));
		expect(JSON.parse(csv.text)).toEqual([
			{ name: "alpha", value: "1" },
			{ name: "beta", value: "2" },
		]);
		expect(["=1+1", "+cmd", "-2", "@ref", "safe"].map(guardCell)).toEqual([
			"'=1+1",
			"'+cmd",
			"'-2",
			"'@ref",
			"safe",
		]);
	});

	it("generates and reopens XLSX with formula cells stored as text", async () => {
		const buffer = await generator("xlsx")({
			sheetName: "Data",
			rows: [
				["name", "value"],
				["formula", "=1+1"],
			],
		});
		const preview = await parser("xlsx")(buffer);
		expect(JSON.parse(preview.text)).toEqual([
			["name", "value"],
			["formula", "'=1+1"],
		]);
	});

	it("generates and reopens DOCX, PDF, and PPTX documents", async () => {
		const docx = await generator("docx")({ title: "Report", paragraphs: ["First paragraph"] });
		await expect(parser("docx")(docx)).resolves.toMatchObject({
			text: expect.stringContaining("First paragraph"),
		});

		const pdf = await generator("pdf")({ title: "Report", text: "First line\nSecond line" });
		await expect(parser("pdf")(pdf)).resolves.toMatchObject({
			text: expect.stringContaining("Second line"),
		});

		const pptx = await generator("pptx")({
			slides: [{ title: "Slide title", body: "Slide body" }],
		});
		await expect(parser("pptx")(pptx)).resolves.toMatchObject({
			text: expect.stringContaining("Slide body"),
		});
	});

	it("extracts dimensions from an actual PNG and degrades malformed inputs per codec", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
			"base64",
		);
		await expect(parser("image")(png)).resolves.toMatchObject({
			metadata: { width: 1, height: 1, type: "png" },
		});
		await expect(parser("xlsx")(Buffer.from("not a valid document"))).resolves.toEqual({
			text: '[["not a valid document"]]',
		});
		for (const kind of ["docx", "pdf", "pptx", "image"]) {
			const result = await parser(kind)(Buffer.from("not a valid document"));
			expect(result.text).toBe("");
			expect(result.error).toEqual(expect.any(String));
		}
	});

	it("supports application codecs without mutating unrelated registrations", async () => {
		const registry = new CodecRegistry();
		registry.register(
			"custom",
			async (buffer) => ({ text: buffer.toString("hex") }),
			async () => Buffer.from("generated"),
		);
		await expect(registry.getParser("custom")?.(Buffer.from("A"))).resolves.toEqual({ text: "41" });
		await expect(registry.getGenerator("custom")?.({})).resolves.toEqual(Buffer.from("generated"));
		expect(registry.getParser("missing")).toBeUndefined();
		expect(registry.getGenerator("text")).toBeUndefined();
	});
});
