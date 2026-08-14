/**
 * Codec registry — preview parsers and document generators for materials.
 *
 * Parsers turn a raw file buffer into plain text for the preview pane (plus
 * optional HTML and metadata). Generators produce binary documents
 * (docx/xlsx/pdf/pptx) from structured params.
 *
 * Every codec package is imported with `await import()` inside the individual
 * functions, not statically: the generator contract requires the import to be
 * wrapped in a try-catch, and a missing or broken codec package must degrade
 * to a per-kind `{ error }` result instead of failing the whole module at
 * import time. This is the deliberate exception to the static-import rule;
 * static imports cannot satisfy the import-in-try-catch contract.
 */

export interface CodecResult {
	text: string;
	html?: string;
	metadata?: Record<string, unknown>;
	error?: string;
}

export type CodecParser = (buffer: Buffer) => Promise<CodecResult>;

export type CodecGenerator = (params: Record<string, unknown>) => Promise<Buffer>;

/**
 * Formula injection guard for spreadsheet cells.
 *
 * If `value` starts with a character that spreadsheet apps interpret as a
 * formula (`=`, `+`, `-`, `@`, tab, or carriage return), a leading single
 * quote is prepended so the cell is treated as literal text.
 */
export function guardCell(value: string): string {
	const first = value[0];
	if (
		first === "=" ||
		first === "+" ||
		first === "-" ||
		first === "@" ||
		first === "\t" ||
		first === "\r"
	) {
		return `'${value}`;
	}
	return value;
}

/** Strip a UTF-8 byte-order mark from the start of a buffer, if present. */
function stripBom(buffer: Buffer): Buffer {
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return buffer.subarray(3);
	}
	return buffer;
}

// ---------------------------------------------------------------------------
// Built-in parsers
// ---------------------------------------------------------------------------

/** Plain text / Markdown: identity, with BOM removal. */
async function parseText(buffer: Buffer): Promise<CodecResult> {
	return { text: stripBom(buffer).toString("utf8") };
}

/** CSV preview: object rows, first 200 records for display. */
async function parseCsv(buffer: Buffer): Promise<CodecResult> {
	try {
		const { parse } = await import("csv-parse/sync");
		// `bom: true` is kept for spec parity, but the BOM is stripped here first:
		// csv-parse 7.0.2 crashes inside delimiter auto-discovery when the input
		// still carries a leading UTF-8 BOM.
		const rows = parse(stripBom(buffer), {
			columns: true,
			bom: true,
			delimiter_auto: true,
			relaxQuotes: true,
			to: 1000,
		});
		return { text: JSON.stringify(rows.slice(0, 200), null, 2) };
	} catch (e) {
		return { text: "", error: String(e) };
	}
}

/** XLSX preview: first sheet as header-less rows, first 200 for display. */
async function parseXlsx(buffer: Buffer): Promise<CodecResult> {
	try {
		const XLSX = await import("xlsx");
		const workbook = XLSX.read(buffer, { type: "buffer" });
		const name = workbook.SheetNames[0];
		const sheet = name !== undefined ? workbook.Sheets[name] : undefined;
		if (sheet === undefined) {
			return { text: "" };
		}
		const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
		return { text: JSON.stringify(rows.slice(0, 200)) };
	} catch (e) {
		return { text: "", error: String(e) };
	}
}

/** DOCX preview via mammoth raw text extraction. */
async function parseDocx(buffer: Buffer): Promise<CodecResult> {
	try {
		const { default: mammoth } = await import("mammoth");
		const result = await mammoth.extractRawText({ buffer });
		return { text: result.value };
	} catch (e) {
		return { text: "", error: String(e) };
	}
}

/** PDF preview: extracted text from the first 20 pages. */
async function parsePdf(buffer: Buffer): Promise<CodecResult> {
	try {
		const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const task = getDocument({ data: new Uint8Array(buffer) });
		const pdf = await task.promise;
		try {
			const pageCount = Math.min(pdf.numPages, 20);
			const parts: string[] = [];
			for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
				const page = await pdf.getPage(pageNumber);
				const content = await page.getTextContent();
				const line = content.items
					.filter((item) => "str" in item)
					.map((item) => item.str)
					.join(" ");
				parts.push(line);
			}
			return { text: parts.join("\n") };
		} finally {
			await pdf.loadingTask.destroy().catch(() => undefined);
		}
	} catch (e) {
		return { text: "", error: String(e) };
	}
}

/** Recursively collect the values of `<a:t>` text nodes from a parsed slide XML tree. */
function collectSlideTexts(node: unknown, out: string[]): void {
	if (Array.isArray(node)) {
		for (const item of node) {
			collectSlideTexts(item, out);
		}
		return;
	}
	if (typeof node !== "object" || node === null) {
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if ((key === "t" || key.endsWith(":t")) && value !== null && value !== undefined) {
			if (typeof value === "string") {
				out.push(value);
			} else if (typeof value === "object") {
				// `<a:t>` carrying attributes parses to `{ "#text": ... }`.
				const text = (value as Record<string, unknown>)["#text"];
				if (typeof text === "string") {
					out.push(text);
				}
			}
		} else {
			collectSlideTexts(value, out);
		}
	}
}

/** PPTX preview: text of the first slide (`ppt/slides/slide1.xml`). */
async function parsePptx(buffer: Buffer): Promise<CodecResult> {
	try {
		const [{ default: JSZip }, { XMLParser }] = await Promise.all([
			import("jszip"),
			import("fast-xml-parser"),
		]);
		const zip = await JSZip.loadAsync(buffer);
		const slideFile = zip.file("ppt/slides/slide1.xml") ?? zip.file("slide1.xml");
		if (slideFile === null) {
			return { text: "" };
		}
		const slideXml = await slideFile.async("string");
		const parsed = new XMLParser().parse(slideXml);
		const texts: string[] = [];
		collectSlideTexts(parsed, texts);
		return { text: texts.join(" ") };
	} catch (e) {
		return { text: "", error: String(e) };
	}
}

/** Image preview: dimensions, format and EXIF metadata — no pixel analysis. */
async function parseImage(buffer: Buffer): Promise<CodecResult> {
	try {
		const [{ imageSize }, { default: exifr }] = await Promise.all([
			import("image-size"),
			import("exifr"),
		]);
		const size = imageSize(new Uint8Array(buffer));
		const metadata: Record<string, unknown> = {
			width: size.width,
			height: size.height,
			type: size.type,
		};
		const exif = await exifr.parse(buffer, {
			pick: ["Orientation", "Make", "Model", "DateTimeOriginal", "Software"],
		});
		if (exif !== undefined && exif !== null && typeof exif === "object") {
			for (const [key, value] of Object.entries(exif)) {
				metadata[key] = value;
			}
		}
		return { text: "", metadata };
	} catch (e) {
		return { text: "", error: String(e) };
	}
}

// ---------------------------------------------------------------------------
// Built-in generators
// ---------------------------------------------------------------------------

/** Minimal structural view of the pptxgenjs API surface this module uses. */
interface PptxGenSlideApi {
	addText(text: string, options?: Record<string, unknown>): void;
}

interface PptxGenApi {
	addSlide(): PptxGenSlideApi;
	write(options: { outputType: "nodebuffer" }): Promise<Uint8Array>;
}

/** DOCX generator: title heading (when given) plus one paragraph per entry. */
async function generateDocx(params: Record<string, unknown>): Promise<Buffer> {
	try {
		const { Document, Packer, Paragraph, TextRun } = await import("docx");
		const { title, paragraphs } = params as { title?: string; paragraphs?: string[] };
		const children: InstanceType<typeof Paragraph>[] = [];
		if (title !== undefined && title !== "") {
			children.push(
				new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 28 })] }),
			);
		}
		for (const paragraph of paragraphs ?? []) {
			children.push(new Paragraph({ children: [new TextRun(paragraph)] }));
		}
		const doc = new Document({ sections: [{ children }] });
		return await Packer.toBuffer(doc);
	} catch (e) {
		throw new Error(String(e));
	}
}

/** XLSX generator: `rows` as a sheet, every cell passed through the formula guard. */
async function generateXlsx(params: Record<string, unknown>): Promise<Buffer> {
	try {
		const XLSX = await import("xlsx");
		const { sheetName, rows } = params as { sheetName?: string; rows?: string[][] };
		const workbook = XLSX.utils.book_new();
		const sheet = XLSX.utils.aoa_to_sheet((rows ?? []).map((row) => row.map(guardCell)));
		XLSX.utils.book_append_sheet(workbook, sheet, sheetName ?? "Sheet1");
		return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
	} catch (e) {
		throw new Error(String(e));
	}
}

/** PDF generator: plain-text page with an optional bold title line. */
async function generatePdf(params: Record<string, unknown>): Promise<Buffer> {
	try {
		const { PDFDocument, StandardFonts } = await import("pdf-lib");
		const { text, title } = params as { text?: string; title?: string };
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		const page = doc.addPage();
		const margin = 50;
		let y = page.getHeight() - margin;
		if (title !== undefined && title !== "") {
			page.drawText(title, { x: margin, y, size: 18, font });
			y -= 30;
		}
		for (const line of (text ?? "").split("\n")) {
			if (y < margin) {
				break;
			}
			page.drawText(line, { x: margin, y, size: 11, font });
			y -= 16;
		}
		return Buffer.from(await doc.save());
	} catch (e) {
		throw new Error(String(e));
	}
}

/** PPTX generator: one slide per entry, title on top and body below. */
async function generatePptx(params: Record<string, unknown>): Promise<Buffer> {
	try {
		// pptxgenjs's bundled d.ts mis-types its default export under ESM
		// resolution (the UMD `export as namespace` shadows the class binding),
		// so the runtime default is cast to the small structural API we use.
		const PptxGenJS = (await import("pptxgenjs")).default as unknown as new () => PptxGenApi;
		const { slides } = params as { slides?: Array<{ title?: string; body?: string }> };
		const pptx = new PptxGenJS();
		const list = slides ?? [];
		if (list.length === 0) {
			pptx.addSlide();
		}
		for (const slide of list) {
			const page = pptx.addSlide();
			if (slide.title !== undefined && slide.title !== "") {
				page.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 0.7, fontSize: 28, bold: true });
			}
			if (slide.body !== undefined && slide.body !== "") {
				page.addText(slide.body, { x: 0.5, y: 1.3, w: 9, h: 4.2, fontSize: 14 });
			}
		}
		const out = await pptx.write({ outputType: "nodebuffer" });
		return Buffer.from(out);
	} catch (e) {
		throw new Error(String(e));
	}
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry of codec parsers and generators, keyed by material kind.
 *
 * Built-in kinds: `text`, `markdown`, `csv`, `xlsx`, `docx`, `pdf`, `pptx`,
 * `image`. `register` can override a built-in or add a new kind.
 */
export class CodecRegistry {
	private parsers = new Map<string, CodecParser>();
	private generators = new Map<string, CodecGenerator>();

	constructor() {
		// text/Markdown — identity parser with BOM removal
		this.register("text", parseText);
		this.register("markdown", parseText);
		this.register("csv", parseCsv);
		this.register("xlsx", parseXlsx, generateXlsx);
		this.register("docx", parseDocx, generateDocx);
		this.register("pdf", parsePdf, generatePdf);
		this.register("pptx", parsePptx, generatePptx);
		this.register("image", parseImage);
	}

	register(kind: string, parser: CodecParser, generator?: CodecGenerator): void {
		this.parsers.set(kind, parser);
		if (generator !== undefined) {
			this.generators.set(kind, generator);
		}
	}

	getParser(kind: string): CodecParser | undefined {
		return this.parsers.get(kind);
	}

	getGenerator(kind: string): CodecGenerator | undefined {
		return this.generators.get(kind);
	}
}

/** Default registry with all built-in codecs registered. */
export const codecRegistry = new CodecRegistry();
