/**
 * M0 spike: Office codec boundaries — real generation, then reopen with an
 * INDEPENDENT read path, structural assertions, hash, MIME sniff, and a save
 * round-trip for DOCX/PDF/XLSX/PPTX.
 *
 * Dev-only evidence tool (never shipped). Run from apps/desktop:
 *   node scripts/m0-spikes/office-spike.mjs <outdir>
 * Writes a JSON report to stdout (and <outdir>/report.json).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const outDir = process.argv[2] ?? join(__dirname, ".out");
await mkdir(outDir, { recursive: true });

/** Deterministic content hash. */
function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

/** MIME sniff via file-type (magic bytes, not extension). */
async function sniffMime(buf) {
	const { fileTypeFromBuffer } = await import("file-type");
	const t = await fileTypeFromBuffer(buf);
	return t ? `${t.mime} (${t.ext})` : "unknown";
}

const report = [];
function record(format, ok, checks) {
	report.push({ format, ok, checks });
}

// ---------------------------------------------------------------------------
// DOCX: generate with `docx`, reopen with `mammoth` (independent path).
// ---------------------------------------------------------------------------
{
	const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
	const doc = new Document({
		sections: [
			{
				children: [
					new Paragraph({ text: "北极光进展报告", heading: HeadingLevel.HEADING_1 }),
					new Paragraph({
						children: [new TextRun("关键里程碑"), new TextRun({ text: "已达成", bold: true })],
					}),
				],
			},
		],
	});
	const buf = await Packer.toBuffer(doc);
	const { default: mammoth } = await import("mammoth");
	const { value } = await mammoth.extractRawText({ buffer: buf });
	const checks = {
		bytes: buf.byteLength,
		sha256: sha256(buf),
		mime: await sniffMime(buf),
		reopenedHasTitle: value.includes("北极光进展报告"),
		reopenedHasBoldText: value.includes("关键里程碑"),
	};
	checks.ok = checks.reopenedHasTitle && checks.reopenedHasBoldText;
	// Save round-trip.
	await writeFile(join(outDir, "spike-report.docx"), buf);
	const saved = await readFile(join(outDir, "spike-report.docx"));
	const { value: v2 } = await mammoth.extractRawText({ buffer: saved });
	checks.savedReopens = v2.includes("北极光进展报告");
	checks.ok &&= checks.savedReopens;
	record("docx", checks.ok, checks);
}

// ---------------------------------------------------------------------------
// PDF: generate with `pdf-lib`, reopen with `pdfjs-dist` (independent path).
// ---------------------------------------------------------------------------
{
	const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
	const doc = await PDFDocument.create();
	const page = doc.addPage([595, 842]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	page.drawText("Aurora Work Loop Report 2026", {
		x: 60,
		y: 760,
		size: 16,
		font,
		color: rgb(0.1, 0.35, 0.3),
	});
	const buf = await doc.save();
	const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const pdf = await getDocument({ data: new Uint8Array(buf) }).promise;
	const p1 = await pdf.getPage(1);
	const content = await p1.getTextContent();
	const text = content.items.map((i) => i.str ?? "").join(" ");
	const checks = {
		bytes: buf.byteLength,
		sha256: sha256(buf),
		mime: await sniffMime(buf),
		pages: pdf.numPages,
		reopenedHasText: text.includes("Aurora Work Loop"),
	};
	checks.ok = checks.pages === 1 && checks.reopenedHasText;
	await writeFile(join(outDir, "spike-report.pdf"), buf);
	const saved = await readFile(join(outDir, "spike-report.pdf"));
	const pdf2 = await getDocument({ data: new Uint8Array(saved) }).promise;
	checks.savedReopens = pdf2.numPages === 1;
	checks.ok &&= checks.savedReopens;
	record("pdf", checks.ok, checks);
}

// ---------------------------------------------------------------------------
// XLSX: generate with vendored SheetJS 0.20.3, reopen with SheetJS read path.
// ---------------------------------------------------------------------------
{
	const XLSX = await import("xlsx");
	const wb = XLSX.utils.book_new();
	const ws = XLSX.utils.aoa_to_sheet([
		["月份", "照片数", "备注"],
		["2026-01", 42, "雪原"],
		["2026-02", 17, "极光"],
	]);
	XLSX.utils.book_append_sheet(wb, ws, "统计");
	const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
	const wb2 = XLSX.read(buf, { type: "buffer" });
	const sheet = wb2.Sheets[wb2.SheetNames[0]];
	const cell = XLSX.utils.sheet_to_json(sheet, { header: 1 });
	const checks = {
		bytes: buf.byteLength,
		sha256: sha256(buf),
		mime: await sniffMime(buf),
		sheetName: wb2.SheetNames[0],
		rows: cell.length,
		cellB2: cell[1]?.[1],
	};
	checks.ok = checks.sheetName === "统计" && checks.rows === 3 && String(checks.cellB2) === "42";
	await writeFile(join(outDir, "spike-report.xlsx"), buf);
	const saved = await readFile(join(outDir, "spike-report.xlsx"));
	const wb3 = XLSX.read(saved, { type: "buffer" });
	checks.savedReopens = XLSX.utils.sheet_to_json(wb3.Sheets[wb3.SheetNames[0]]).length === 2;
	checks.ok &&= checks.savedReopens;
	record("xlsx", checks.ok, checks);
}

// ---------------------------------------------------------------------------
// PPTX: generate with `@office-kit/pptx`, reopen raw with jszip + fast-xml-parser.
// ---------------------------------------------------------------------------
{
	const { addContentSlide, createPresentation, savePresentation } = await import(
		"@office-kit/pptx"
	);
	const pptx = createPresentation();
	addContentSlide(pptx, { title: "雪原营地周会", body: "议程：材料整理" });
	const buf = Buffer.from(await savePresentation(pptx));
	const { default: JSZip } = await import("jszip");
	const zip = await JSZip.loadAsync(buf);
	const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
	const { XMLParser } = await import("fast-xml-parser");
	const parser = new XMLParser({ ignoreAttributes: false });
	const parsed = parser.parse(slideXml);
	const texts = JSON.stringify(parsed).match(/雪原营地周会|议程：材料整理/g) ?? [];
	const checks = {
		bytes: buf.byteLength,
		sha256: sha256(buf),
		mime: await sniffMime(buf),
		zipEntries: Object.keys(zip.files).length,
		slideTextsFound: texts.length,
	};
	checks.ok = checks.zipEntries > 5 && texts.length >= 2;
	await writeFile(join(outDir, "spike-report.pptx"), buf);
	const saved = await readFile(join(outDir, "spike-report.pptx"));
	const zip2 = await JSZip.loadAsync(saved);
	const slideXml2 = await zip2.file("ppt/slides/slide1.xml").async("string");
	checks.savedReopens = slideXml2.includes("雪原营地周会");
	checks.ok &&= checks.savedReopens;
	record("pptx", checks.ok, checks);
}

// ---------------------------------------------------------------------------
// Formula-injection guard demonstration (CSV/XLSX writer prefix).
// ---------------------------------------------------------------------------
{
	const XLSX = await import("xlsx");
	const wb = XLSX.utils.book_new();
	const ws = XLSX.utils.aoa_to_sheet(
		[['=HYPERLINK("http://evil","x")'], ["+SUM(1,1)"], ["-1+1"], ["@cmd"], ["\tTAB"]].map((r) => [
			guard(r[0]),
		]),
	);
	XLSX.utils.book_append_sheet(wb, ws, "guard");
	const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
	const wb2 = XLSX.read(buf, { type: "buffer" });
	const out = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1 }).flat();
	const checks = { cells: out };
	checks.ok = out.every((v) => typeof v === "string" && v.startsWith("'"));
	record("formula-injection-guard", checks.ok, checks);
}

function guard(v) {
	return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
const allOk = report.every((r) => r.ok);
console.log(JSON.stringify(report, null, 2));
console.log(
	`\nM0 office spike: ${allOk ? "PASS" : "FAIL"} (report at ${join(outDir, "report.json")})`,
);
process.exit(allOk ? 0 : 1);
