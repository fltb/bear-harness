/**
 * Material ingest pipeline — the front door of the materials subsystem.
 *
 * Every material entering the system passes through here: the logical name is
 * sanitized, the buffer is sniffed by magic bytes (file-type) and validated
 * against its extension, encrypted containers and zip bombs are rejected
 * before any decompression happens, per-kind size/page budgets are enforced,
 * and survivors are written to the content-addressed ArtifactStore. The
 * result is a typed `MaterialRef` preview model; failure reasons are
 * first-class kinds (`malicious`, `encrypted`, `too_large`, `zip_bomb`,
 * `unsupported`) with `state: "failed"`, never exceptions.
 *
 * Budget and bomb limits follow the §11.1 materials plan:
 *   text/markdown 10 MiB · csv/xlsx 200 MiB · pdf 200 MiB / 200 pages ·
 *   docx/pptx 50 MiB · source 1 MiB · image 25 MiB · unknown/binary 1 MiB
 *   zip containers: ≤1000 entries, ≤50 MiB per entry, ≤200 MiB total
 *   decompressed, depth ≤8, compression ratio ≤100:1.
 *
 * An optional `AbortSignal` cancels long work (magic sniff, page count, bomb
 * sampling, CAS write) and yields a `state: "cancelled"` ref. `sha256` is
 * authoritative for `ready` refs (computed by ArtifactStore); failed refs
 * carry the real hash when the buffer is small enough to hash cheaply,
 * otherwise an empty string. Cancelled refs never hash.
 */

import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { FileTypeResult } from "file-type";
import { fileTypeFromBuffer } from "file-type";
import JSZip from "jszip";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ArtifactStore } from "../artifacts/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MaterialKind =
	| "text"
	| "markdown"
	| "csv"
	| "xlsx"
	| "docx"
	| "pdf"
	| "pptx"
	| "image"
	| "source"
	| "unknown"
	| "unsupported"
	| "encrypted"
	| "too_large"
	| "zip_bomb"
	| "malicious";

export type MaterialState = "ready" | "failed" | "cancelled";

export interface MaterialRef {
	id: string;
	kind: MaterialKind;
	logicalName: string;
	bytes: number;
	sha256: string;
	mime: string;
	state: MaterialState;
}

/** jszip's public ZipObject hides the central-directory sizes it keeps on `_data`. */
interface ZipObjectWithInternalData {
	_data?: unknown;
}

/** The size fields jszip parses from the central directory for each entry. */
interface ZipObjectSizes {
	compressedSize: number;
	uncompressedSize: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIB = 1024;
const MIB = 1024 * KIB;

/** Maximum sanitized logical name length (characters). */
const MAX_NAME_LENGTH = 255;
/** Fallback logical name when sanitization leaves nothing. */
const FALLBACK_NAME = "untitled";
/** Above this size failed refs skip hashing (hash is diagnostic sugar there). */
const FAILED_HASH_MAX_BYTES = 64 * MIB;

/** PDF page budget (§11.1). */
const PDF_MAX_PAGES = 200;

/** Per-kind size budgets (§11.1). Failure kinds never reach the budget check. */
const BUDGET_LIMITS: Readonly<Record<MaterialKind, number>> = {
	text: 10 * MIB,
	markdown: 10 * MIB,
	csv: 200 * MIB,
	xlsx: 200 * MIB,
	pdf: 200 * MIB,
	docx: 50 * MIB,
	pptx: 50 * MIB,
	image: 25 * MIB,
	source: 1 * MIB,
	unknown: 1 * MIB,
	unsupported: 1 * MIB,
	encrypted: 1 * MIB,
	too_large: 1 * MIB,
	zip_bomb: 1 * MIB,
	malicious: 1 * MIB,
};

/** Kinds that are admitted into the artifact store. */
const SUPPORTED_KINDS: Readonly<Partial<Record<MaterialKind, true>>> = {
	text: true,
	markdown: true,
	csv: true,
	xlsx: true,
	docx: true,
	pdf: true,
	pptx: true,
	image: true,
	source: true,
};

/** Container bomb gate (§11.1) — zip-based formats only. */
const ZIP_MAX_ENTRIES = 1000;
const ZIP_MAX_ENTRY_BYTES = 50 * MIB;
const ZIP_MAX_TOTAL_BYTES = 200 * MIB;
const ZIP_MAX_DEPTH = 8;
const ZIP_MAX_RATIO = 100;

/** Extension → kind mapping (disambiguation + fallback, never authoritative). */
const EXTENSION_KINDS: Readonly<Record<string, MaterialKind>> = {
	// documents
	txt: "text",
	md: "markdown",
	markdown: "markdown",
	mdown: "markdown",
	csv: "csv",
	xlsx: "xlsx",
	docx: "docx",
	pdf: "pdf",
	pptx: "pptx",
	// source
	json: "source",
	js: "source",
	mjs: "source",
	cjs: "source",
	ts: "source",
	tsx: "source",
	jsx: "source",
	py: "source",
	rb: "source",
	go: "source",
	rs: "source",
	java: "source",
	c: "source",
	h: "source",
	cpp: "source",
	hpp: "source",
	cc: "source",
	cs: "source",
	php: "source",
	swift: "source",
	kt: "source",
	sh: "source",
	bash: "source",
	zsh: "source",
	yml: "source",
	yaml: "source",
	toml: "source",
	xml: "source",
	css: "source",
	html: "source",
	htm: "source",
	sql: "source",
	lua: "source",
	pl: "source",
	r: "source",
	dart: "source",
	scala: "source",
	ex: "source",
	exs: "source",
	erl: "source",
	clj: "source",
	vue: "source",
	svelte: "source",
	// images
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	bmp: "image",
	svg: "image",
	tiff: "image",
	tif: "image",
	avif: "image",
	ico: "image",
	heic: "image",
};

/** Extension → mime fallback, used only when magic bytes find nothing. */
const EXTENSION_MIMES: Readonly<Record<string, string>> = {
	md: "text/markdown",
	markdown: "text/markdown",
	txt: "text/plain",
	text: "text/plain",
	csv: "text/csv",
	json: "application/json",
	js: "application/javascript",
	mjs: "application/javascript",
	cjs: "application/javascript",
	ts: "application/typescript",
	tsx: "application/typescript",
	xml: "application/xml",
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	py: "text/x-python",
	rb: "text/x-ruby",
	go: "text/x-go",
	rs: "text/x-rust",
	sh: "text/x-shellscript",
	yml: "text/yaml",
	yaml: "text/yaml",
	toml: "text/x-toml",
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	tiff: "image/tiff",
	tif: "image/tiff",
	avif: "image/avif",
	ico: "image/x-icon",
	heic: "image/heic",
};

/** Office extensions whose native container is CFB only when encrypted. */
const OFFICE_EXTENSIONS: Readonly<Record<string, true>> = {
	docx: true,
	xlsx: true,
	pptx: true,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a logical file name: strip CR/LF and Windows reserved characters
 * (`<>:"/\|?*`), cap at 255 characters, and fall back to `untitled`.
 */
export function sanitizeName(name: string): string {
	const cleaned = Array.from(name.replace(/[\r\n<>:"/\\|?*]/g, ""))
		.slice(0, MAX_NAME_LENGTH)
		.join("");
	return cleaned.length === 0 ? FALLBACK_NAME : cleaned;
}

/**
 * Map a MIME type (plus an extension hint) to a material kind.
 *
 * The MIME type is authoritative; the extension only disambiguates generic
 * signals — `text/plain` with a `.md`/`.csv`/code extension, or
 * `application/octet-stream`/unlisted MIME types that carry a known
 * extension.
 */
export function sniffKind(mime: string, extension: string): MaterialKind {
	const normalized = mime.trim().toLowerCase();
	const ext = extension.trim().replace(/^\.+/, "").toLowerCase();
	const extKind = EXTENSION_KINDS[ext] ?? "unknown";

	switch (normalized) {
		case "text/plain":
			// Generic text — the extension names the dialect when it knows one.
			if (extKind === "markdown" || extKind === "csv" || extKind === "source") {
				return extKind;
			}
			return "text";
		case "text/markdown":
			return "markdown";
		case "text/csv":
			return "csv";
		case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
			return "xlsx";
		case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
			return "docx";
		case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
			return "pptx";
		case "application/pdf":
			return "pdf";
		case "application/javascript":
		case "application/json":
		case "application/xml":
		case "application/typescript":
			return "source";
		default:
			break;
	}

	if (normalized.startsWith("image/")) return "image";
	if (normalized.startsWith("text/x-")) return "source";

	// Generic or unlisted MIME — trust a known extension, else unknown.
	return extKind === "unknown" ? "unknown" : extKind;
}

/** Magic-byte sniff; a sniff failure degrades to "no magic", never throws. */
async function sniffMagic(buffer: Buffer): Promise<FileTypeResult | undefined> {
	try {
		return await fileTypeFromBuffer(buffer);
	} catch {
		return undefined;
	}
}

/** Best-effort MIME: magic first, then extension, then text heuristic. */
function sniffMime(magic: FileTypeResult | undefined, extension: string, buffer: Buffer): string {
	if (magic) return magic.mime;
	const fromExtension = EXTENSION_MIMES[extension];
	if (fromExtension) return fromExtension;
	if (looksLikeText(buffer)) return "text/plain";
	return "application/octet-stream";
}

/** True when the sample (first 8 KiB) has no NUL bytes and decodes as UTF-8. */
function looksLikeText(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.byteLength, 8192));
	if (sample.includes(0)) return false;
	// Drop the tail 4 bytes so a multi-byte character straddling the sample
	// boundary cannot fail the fatal decode.
	const head = sample.subarray(0, Math.max(0, sample.byteLength - 4));
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(head);
		return true;
	} catch {
		return false;
	}
}

/**
 * Extension/magic disagreement — the buffer's magic identifies a *different
 * kind* than the extension claims. Office extensions accept zip/CFB magic
 * because OOXML *is* a zip (and may fall back to plain-zip detection when an
 * entry exceeds file-type's bounded scan); everything else under an office
 * extension is a mismatched payload.
 */
function isMalicious(magic: FileTypeResult | undefined, extension: string): boolean {
	if (!magic) return false;
	const magicKind = sniffKind(magic.mime, magic.ext);
	const extKind = EXTENSION_KINDS[extension] ?? "unknown";
	if (magicKind !== "unknown" && extKind !== "unknown" && magicKind !== extKind) {
		return true;
	}
	if (
		(extKind === "pdf" ||
			extKind === "docx" ||
			extKind === "xlsx" ||
			extKind === "pptx" ||
			extKind === "image") &&
		magicKind === "unknown" &&
		magic.ext !== "zip" &&
		magic.ext !== "cfb"
	) {
		return true;
	}
	return false;
}

/** Encrypted containers: zip GP-flag encryption, or CFB under an office name. */
function isEncrypted(
	buffer: Buffer,
	magic: FileTypeResult | undefined,
	extension: string,
): boolean {
	if (zipFirstEntryEncrypted(buffer)) return true;
	if (magic?.ext === "cfb" && OFFICE_EXTENSIONS[extension] === true) return true;
	return false;
}

/**
 * Read the general-purpose bit flag of the first ZIP local file header
 * (PK\x03\x04, flag at offset 6): bit 0 set means the entry is encrypted.
 * Conventionally encrypted archives encrypt every entry, so the first header
 * is sufficient; a later-only encrypted entry would still fail to read in the
 * codec layer. Empty zips (PK\x05\x06) are not encrypted.
 */
function zipFirstEntryEncrypted(buffer: Buffer): boolean {
	if (buffer.byteLength < 8 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
	if (buffer[2] === 0x03 && buffer[3] === 0x04) {
		return (buffer.readUInt16LE(6) & 0x0001) === 0x0001;
	}
	return false;
}

/** sha256 for failed refs — bounded so rejecting a giant file stays cheap. */
function bestEffortSha256(buffer: Buffer): string {
	if (buffer.byteLength > FAILED_HASH_MAX_BYTES) return "";
	return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Container bomb gate
// ---------------------------------------------------------------------------

type ZipCheckResult = { ok: true } | { ok: false; reason: "zip_bomb" | "unreadable" };

/**
 * Zip bomb gate — central-directory metadata only, never decompresses.
 * Uses jszip.loadAsync to enumerate entries; per-entry sizes come from the
 * internal `_data` (a CompressedObject jszip retains after load), which holds
 * the sizes parsed from the central directory.
 */
async function checkZipContainer(buffer: Buffer): Promise<ZipCheckResult> {
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(buffer);
	} catch {
		return { ok: false, reason: "unreadable" };
	}

	let entries = 0;
	let totalUncompressed = 0;
	for (const entry of Object.values(zip.files)) {
		entries += 1;
		if (entries > ZIP_MAX_ENTRIES) return { ok: false, reason: "zip_bomb" };

		const zipObject = entry as ZipObjectWithInternalData; // public type omits _data
		const data = zipObject._data;
		if (!data || typeof data !== "object" || entry.dir) continue;
		const sizes = data as ZipObjectSizes;

		if (entry.name.split(/[\\/]/).length > ZIP_MAX_DEPTH) return { ok: false, reason: "zip_bomb" };
		if (sizes.uncompressedSize > ZIP_MAX_ENTRY_BYTES) return { ok: false, reason: "zip_bomb" };
		if (
			sizes.compressedSize > 0 &&
			sizes.uncompressedSize > 0 &&
			sizes.uncompressedSize / sizes.compressedSize > ZIP_MAX_RATIO
		) {
			return { ok: false, reason: "zip_bomb" };
		}

		totalUncompressed += sizes.uncompressedSize;
		if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) return { ok: false, reason: "zip_bomb" };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// PDF page budget
// ---------------------------------------------------------------------------

type PdfPageResult =
	| { kind: "pages"; pages: number }
	| { kind: "encrypted" }
	| { kind: "unreadable" };

/** Load the PDF (metadata only — page count, never rendering) and count pages. */
async function countPdfPages(buffer: Buffer): Promise<PdfPageResult> {
	const task = pdfjs.getDocument({
		data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
	});
	try {
		const doc = await task.promise;
		const pages = doc.numPages;
		await task.destroy();
		return { kind: "pages", pages };
	} catch (error) {
		// pdfjs reports password-protected PDFs by throwing a PasswordException.
		const cause = error as { name?: string };
		const outcome = cause.name === "PasswordException" ? "encrypted" : "unreadable";
		await task.destroy().catch(() => {});
		return { kind: outcome };
	}
}

// ---------------------------------------------------------------------------
// IngestService
// ---------------------------------------------------------------------------

/**
 * Cancellation probe. A helper (not an inline `signal?.aborted` check)
 * because TypeScript narrows `signal.aborted` to `false` after the first
 * guard, which would make later post-await checks unreachable — but the
 * signal may abort *during* the awaits.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

export class IngestService {
	private artifactStore: ArtifactStore;

	constructor(artifactStore: ArtifactStore) {
		this.artifactStore = artifactStore;
	}

	/**
	 * Ingest a material buffer: sanitize → magic sniff → extension/magic
	 * validation → encrypted/bomb/budget gates → CAS write. Never throws for
	 * rejected input; failures are typed `MaterialRef`s with
	 * `state: "failed"` (or `"cancelled"` when `signal` aborts).
	 */
	async ingest(params: {
		buffer: Buffer;
		logicalName: string;
		signal?: AbortSignal;
	}): Promise<MaterialRef> {
		const { buffer, signal } = params;
		const logicalName = sanitizeName(params.logicalName);
		const extension = extname(logicalName).replace(/^\./, "").toLowerCase();

		const magic = await sniffMagic(buffer);
		const mime = sniffMime(magic, extension, buffer);
		const kind = sniffKind(mime, extension);

		if (isAborted(signal)) return this.failed("unknown", logicalName, buffer, mime, "cancelled");

		// Extension and magic disagree — a masqueraded payload.
		if (isMalicious(magic, extension)) {
			return this.failed("malicious", logicalName, buffer, mime, "failed");
		}

		// Encrypted containers cannot be read by any codec.
		if (isEncrypted(buffer, magic, extension)) {
			return this.failed("encrypted", logicalName, buffer, mime, "failed");
		}

		// Per-kind size budget.
		if (buffer.byteLength > BUDGET_LIMITS[kind]) {
			return this.failed("too_large", logicalName, buffer, mime, "failed");
		}
		if (isAborted(signal)) return this.failed(kind, logicalName, buffer, mime, "cancelled");

		// PDF page budget.
		if (kind === "pdf") {
			const pages = await countPdfPages(buffer);
			if (pages.kind === "encrypted") {
				return this.failed("encrypted", logicalName, buffer, mime, "failed");
			}
			if (pages.kind === "unreadable") {
				return this.failed(kind, logicalName, buffer, mime, "failed");
			}
			if (pages.pages > PDF_MAX_PAGES) {
				return this.failed("too_large", logicalName, buffer, mime, "failed");
			}
		}

		// Container bomb gate for zip-based office formats.
		if (kind === "xlsx" || kind === "docx" || kind === "pptx") {
			const zip = await checkZipContainer(buffer);
			if (!zip.ok) {
				return this.failed(
					zip.reason === "zip_bomb" ? "zip_bomb" : kind,
					logicalName,
					buffer,
					mime,
					"failed",
				);
			}
		}

		// Everything else is not ingestible.
		if (SUPPORTED_KINDS[kind] !== true) {
			return this.failed("unsupported", logicalName, buffer, mime, "failed");
		}
		if (isAborted(signal)) return this.failed(kind, logicalName, buffer, mime, "cancelled");

		const record = this.artifactStore.create({ logicalName, buffer, mime });
		return {
			id: record.id,
			kind,
			logicalName,
			bytes: buffer.byteLength,
			sha256: record.sha256,
			mime,
			state: "ready",
		};
	}

	/** Build a failed/cancelled ref; sha256 is best-effort except cancelled. */
	private failed(
		kind: MaterialKind,
		logicalName: string,
		buffer: Buffer,
		mime: string,
		state: "failed" | "cancelled",
	): MaterialRef {
		return {
			id: randomUUID(),
			kind,
			logicalName,
			bytes: buffer.byteLength,
			sha256: state === "cancelled" ? "" : bestEffortSha256(buffer),
			mime,
			state,
		};
	}
}
