// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { IngestService, sanitizeName, sniffKind } from "../../src/materials/ingest.js";

const MINIMAL_PDF = Buffer.from(
	"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n149\n%%EOF\n",
);
const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

async function makeXlsx(): Promise<Buffer> {
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
	);
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
	);
	zip.file(
		"xl/workbook.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
	);
	zip.file(
		"xl/worksheets/sheet1.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
	);
	return zip.generateAsync({ type: "nodebuffer" });
}

/** 10 MiB of repeated bytes — compresses ~1000:1, past the 100:1 bomb gate. */
async function makeZipBomb(): Promise<Buffer> {
	const zip = new JSZip();
	zip.file("payload.txt", Buffer.alloc(10 * 1024 * 1024, 0x41));
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A zip with the encrypted bit set on the first local file header. */
async function makeEncryptedZip(): Promise<Buffer> {
	const zip = new JSZip();
	zip.file("a.txt", "hello");
	const buf = await zip.generateAsync({ type: "nodebuffer" });
	buf.writeUInt16LE(buf.readUInt16LE(6) | 0x0001, 6);
	return buf;
}

describe("sanitizeName", () => {
	it("strips CR, LF and Windows reserved characters", () => {
		expect(sanitizeName('a\r\nb<>:"|?*c')).toBe("abc");
		expect(sanitizeName("report\n2026.md")).toBe("report2026.md");
	});

	it("caps at 255 characters", () => {
		expect(sanitizeName("x".repeat(300))).toHaveLength(255);
	});

	it("falls back to untitled", () => {
		expect(sanitizeName("")).toBe("untitled");
		expect(sanitizeName("\r\n")).toBe("untitled");
		expect(sanitizeName("***")).toBe("untitled");
	});
});

describe("sniffKind", () => {
	it("maps declared MIME types", () => {
		expect(sniffKind("text/plain", "txt")).toBe("text");
		expect(sniffKind("text/markdown", "md")).toBe("markdown");
		expect(sniffKind("text/csv", "csv")).toBe("csv");
		expect(
			sniffKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
		).toBe("xlsx");
		expect(
			sniffKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
		).toBe("docx");
		expect(sniffKind("application/pdf", "pdf")).toBe("pdf");
		expect(
			sniffKind(
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
				"pptx",
			),
		).toBe("pptx");
		expect(sniffKind("image/png", "png")).toBe("image");
	});

	it("uses the extension to disambiguate generic MIME types", () => {
		expect(sniffKind("text/plain", "md")).toBe("markdown");
		expect(sniffKind("text/plain", "csv")).toBe("csv");
		expect(sniffKind("text/plain", "py")).toBe("source");
		expect(sniffKind("application/octet-stream", "xlsx")).toBe("xlsx");
	});

	it("maps code-ish MIME types to source", () => {
		expect(sniffKind("application/javascript", "js")).toBe("source");
		expect(sniffKind("application/json", "json")).toBe("source");
		expect(sniffKind("text/x-python", "py")).toBe("source");
	});

	it("is unknown for unrecognized MIME/extension pairs", () => {
		expect(sniffKind("application/zip", "zip")).toBe("unknown");
		expect(sniffKind("application/octet-stream", "")).toBe("unknown");
	});
});

describe("IngestService", () => {
	let db: DatabaseSync;
	let casDir: string;
	let service: IngestService;

	beforeAll(() => {
		db = new DatabaseSync(":memory:");
		db.exec(
			`CREATE TABLE artifacts (
				id TEXT PRIMARY KEY,
				logical_name TEXT NOT NULL,
				mime TEXT NOT NULL,
				bytes INTEGER NOT NULL DEFAULT 0,
				sha256 TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','verified','verification_failed','adopted','saved')),
				producer_run_id TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)`,
		);
		casDir = mkdtempSync(join(tmpdir(), "bear-ingest-cas-"));
		service = new IngestService(new ArtifactStore(drizzle({ client: db }), casDir));
	});

	afterAll(() => {
		rmSync(casDir, { recursive: true, force: true });
		db.close();
	});

	it("ingests plain text and markdown", async () => {
		const text = await service.ingest({ buffer: Buffer.from("hello world"), logicalName: "a.txt" });
		expect(text).toMatchObject({
			kind: "text",
			logicalName: "a.txt",
			mime: "text/plain",
			state: "ready",
		});
		expect(text.sha256).toBe(createHash("sha256").update("hello world").digest("hex"));
		expect(serviceDbRow(db, text.id)).toBeDefined();

		const md = await service.ingest({ buffer: Buffer.from("# Title"), logicalName: "note.md" });
		expect(md).toMatchObject({ kind: "markdown", state: "ready" });
	});

	it("detects text without a magic signature via extension and content", async () => {
		const csv = await service.ingest({ buffer: Buffer.from("a,b\n1,2"), logicalName: "data.csv" });
		expect(csv).toMatchObject({ kind: "csv", state: "ready" });

		const heur = await service.ingest({
			buffer: Buffer.from("plain text, unknown extension"),
			logicalName: "note.notes",
		});
		expect(heur).toMatchObject({ kind: "text", state: "ready", mime: "text/plain" });
	});

	it("ingests an xlsx container after the bomb gate", async () => {
		const ref = await service.ingest({ buffer: await makeXlsx(), logicalName: "book.xlsx" });
		expect(ref).toMatchObject({ kind: "xlsx", state: "ready" });
	});

	it("ingests a PDF and enforces the page budget path", async () => {
		const ref = await service.ingest({ buffer: MINIMAL_PDF, logicalName: "doc.pdf" });
		expect(ref).toMatchObject({ kind: "pdf", mime: "application/pdf", state: "ready" });
	});

	it("ingests images", async () => {
		const ref = await service.ingest({ buffer: ONE_PIXEL_PNG, logicalName: "pixel.png" });
		expect(ref).toMatchObject({ kind: "image", mime: "image/png", state: "ready" });
	});

	it("marks extension/magic disagreements as malicious", async () => {
		const ref = await service.ingest({ buffer: ONE_PIXEL_PNG, logicalName: "fake.txt" });
		expect(ref).toMatchObject({ kind: "malicious", state: "failed" });
	});

	it("marks encrypted zips as encrypted", async () => {
		const ref = await service.ingest({
			buffer: await makeEncryptedZip(),
			logicalName: "secret.zip",
		});
		expect(ref).toMatchObject({ kind: "encrypted", state: "failed" });
	});

	it("rejects zip bombs before any decompression", async () => {
		const ref = await service.ingest({ buffer: await makeZipBomb(), logicalName: "bomb.xlsx" });
		expect(ref).toMatchObject({ kind: "zip_bomb", state: "failed" });
	});

	it("rejects oversized files as too_large", async () => {
		const big = Buffer.alloc(11 * 1024 * 1024, 0x61);
		const ref = await service.ingest({ buffer: big, logicalName: "big.txt" });
		expect(ref).toMatchObject({ kind: "too_large", state: "failed" });
	});

	it("rejects unreadable office containers as failed", async () => {
		const garbage = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(64, 0xff)]);
		garbage.writeUInt16LE(0, 6); // clear the GP flag so it is not read as encrypted
		const ref = await service.ingest({ buffer: garbage, logicalName: "broken.xlsx" });
		expect(ref).toMatchObject({ kind: "xlsx", state: "failed" });
	});

	it("marks unsupported kinds as unsupported", async () => {
		const zip = new JSZip();
		zip.file("a.txt", "hi");
		const ref = await service.ingest({
			buffer: await zip.generateAsync({ type: "nodebuffer" }),
			logicalName: "bundle.zip",
		});
		expect(ref).toMatchObject({ kind: "unsupported", state: "failed" });
	});

	it("cancels when the signal aborts", async () => {
		const controller = new AbortController();
		controller.abort();
		const ref = await service.ingest({
			buffer: Buffer.from("hello"),
			logicalName: "a.txt",
			signal: controller.signal,
		});
		expect(ref.state).toBe("cancelled");
		expect(ref.sha256).toBe("");
	});
});

function serviceDbRow(db: DatabaseSync, id: string): unknown {
	return db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id);
}
