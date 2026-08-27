import { resolve } from "node:path";
import {
	exportDiagnosticTrace,
	findLatestCompanionTurnTraceId,
} from "../packages/host-runtime/dist/index.js";

function readArgument(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const rootArgument = readArgument("--root");
const outputArgument = readArgument("--output");
if (!rootArgument || !outputArgument) {
	throw new Error(
		"Usage: npm run diagnostics:export -- --root <diagnostics-root> --output <file> [--trace <id>|--latest-turn]",
	);
}

const root = resolve(rootArgument);
const output = resolve(outputArgument);
let traceId = readArgument("--trace");
if (!traceId && process.argv.includes("--latest-turn")) {
	traceId = await findLatestCompanionTurnTraceId(root);
}
if (!traceId) throw new Error("No trace selected or no completed companion turn was found");

const result = await exportDiagnosticTrace(root, traceId, output);
process.stdout.write(
	`${JSON.stringify({ output, traceId, records: result.records.length, invalidLines: result.invalidLines, truncated: result.truncated })}\n`,
);
