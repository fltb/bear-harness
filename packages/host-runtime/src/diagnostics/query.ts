import { createReadStream, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { DiagnosticRecordV1 } from "./contracts.js";
import { validateRecord } from "./contracts.js";

const TRACE_ID = /^[0-9a-f]{32}$/;
const LOG_FILE = /^app-.+-\d{8}-\d+\.jsonl$/;
const DEFAULT_MAX_RECORDS = 10_000;

export interface DiagnosticTraceQueryResult {
	traceId: string;
	records: DiagnosticRecordV1[];
	invalidLines: number;
	truncated: boolean;
}

export interface DiagnosticTraceQueryOptions {
	maxRecords?: number;
}

function assertTraceId(traceId: string): void {
	if (!TRACE_ID.test(traceId) || !/[1-9a-f]/.test(traceId)) {
		throw new TypeError("traceId must be 32 lowercase hexadecimal digits and not all zeroes");
	}
}

async function diagnosticLogFiles(root: string): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(join(root, "logs"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names
		.filter((name) => LOG_FILE.test(name))
		.sort()
		.map((name) => join(root, "logs", name));
}

/** Read one complete local trace without accepting arbitrary paths or malformed records. */
export async function readDiagnosticTrace(
	root: string,
	traceId: string,
	options: DiagnosticTraceQueryOptions = {},
): Promise<DiagnosticTraceQueryResult> {
	assertTraceId(traceId);
	const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
	if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > DEFAULT_MAX_RECORDS) {
		throw new RangeError(`maxRecords must be an integer from 1 to ${DEFAULT_MAX_RECORDS}`);
	}
	const records: DiagnosticRecordV1[] = [];
	let invalidLines = 0;
	let truncated = false;
	for (const file of await diagnosticLogFiles(root)) {
		const lines = createInterface({
			input: createReadStream(file, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});
		for await (const line of lines) {
			if (line.length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				invalidLines += 1;
				continue;
			}
			if (validateRecord(parsed).length > 0) {
				invalidLines += 1;
				continue;
			}
			const record = parsed as DiagnosticRecordV1;
			if (record.traceId !== traceId) continue;
			if (records.length >= maxRecords) {
				truncated = true;
				continue;
			}
			records.push(record);
		}
	}
	return { traceId, records, invalidLines, truncated };
}

/** Find the most recently completed companion turn in the retained local logs. */
export async function findLatestCompanionTurnTraceId(root: string): Promise<string | null> {
	let latest: DiagnosticRecordV1 | null = null;
	for (const file of await diagnosticLogFiles(root)) {
		const lines = createInterface({
			input: createReadStream(file, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});
		for await (const line of lines) {
			if (line.length === 0) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (validateRecord(parsed).length > 0) continue;
				const record = parsed as DiagnosticRecordV1;
				if (record.name !== "companion.turn") continue;
				if (!latest || record.timestamp > latest.timestamp) latest = record;
			} catch {
				// A partial last line must not make the rest of the diagnostics unreadable.
			}
		}
	}
	return latest?.traceId ?? null;
}

/** Atomically export a trace as a stable, local JSON evidence bundle. */
export async function exportDiagnosticTrace(
	root: string,
	traceId: string,
	outputFile: string,
	options: DiagnosticTraceQueryOptions = {},
): Promise<DiagnosticTraceQueryResult> {
	const result = await readDiagnosticTrace(root, traceId, options);
	const outputDir = dirname(outputFile);
	mkdirSync(outputDir, { recursive: true, mode: 0o700 });
	const temporaryFile = join(outputDir, `.${basename(outputFile)}.${process.pid}.tmp`);
	try {
		writeFileSync(temporaryFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryFile, outputFile);
	} catch (error) {
		await unlink(temporaryFile).catch(() => undefined);
		throw error;
	}
	return result;
}
