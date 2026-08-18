/**
 * M0 spike: Pi worker strict LF JSONL framing.
 *
 * 1. Verifies the SDK's own jsonl primitives against a hostile corpus
 *    (CRLF, U+2028/U+2029 inside JSON strings, partial records, bad JSON).
 * 2. Spawns the pinned rpc-entry runtime (0.84.1 from our lockfile) and
 *    verifies end-to-end framing: response arrives as exactly one LF line.
 *
 * Dev-only evidence tool (never shipped). Run from apps/desktop:
 *   node scripts/m0-spikes/rpc-framing-spike.mjs
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The workspace hoists @earendil-works/pi-coding-agent at the repo root;
// walk up until we find it.
function resolveSdkDist() {
	let dir = __dirname;
	for (let i = 0; i < 6; i += 1) {
		const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {
			/* keep walking */
		}
		dir = dirname(dir);
	}
	throw new Error("pi-coding-agent dist not found");
}
const SDK_DIST = resolveSdkDist();
const RPC_ENTRY = join(SDK_DIST, "rpc-entry.js");

const { serializeJsonLine, attachJsonlLineReader } = await import(
	join(SDK_DIST, "modes", "rpc", "jsonl.js")
);

const report = [];
function record(name, ok, checks) {
	report.push({ name, ok, checks });
}

// --- 1. serializeJsonLine round-trip -------------------------------------
{
	const obj = {
		type: "response",
		command: "get_state",
		success: true,
		data: { id: "x\u2028y\u2029z" },
	};
	const line = serializeJsonLine(obj);
	const checks = {
		endsWithLf: line.endsWith("\n"),
		singleLine: !line.slice(0, -1).includes("\n"),
		parseRoundTrip: JSON.parse(line).data.id === "x\u2028y\u2029z",
	};
	checks.ok = checks.endsWithLf && checks.singleLine && checks.parseRoundTrip;
	record("serializeJsonLine", checks.ok, checks);
}

// --- 2. attachJsonlLineReader hostile corpus ------------------------------
// The SDK primitive is framing-only: raw lines are handed to the caller, which
// owns JSON.parse + error classification (that is our Worker adapter contract).
// So we wrap it exactly like the M3 adapter will: line -> JSON.parse, with
// parse failures routed to an error channel.
{
	const stream = new PassThrough();
	const received = [];
	const errors = [];
	const detach = attachJsonlLineReader(stream, (line) => {
		try {
			received.push(JSON.parse(line));
		} catch {
			errors.push(line);
		}
	});

	// Feed deliberately awkward chunk boundaries and content:
	// - record with embedded U+2028 / U+2029 (must NOT split on them)
	// - CRLF record (must strip trailing \r)
	// - two records in one chunk, one record split across chunks
	// - a bad JSON line (must surface as a parse error, never as a record)
	const a = serializeJsonLine({ type: "evt", payload: "a\u2028b" });
	const b = '{"type":"evt","payload":"crlf"}\r\n';
	const c = serializeJsonLine({ type: "evt", n: 1 });
	const d = serializeJsonLine({ type: "evt", n: 2 });
	const bad = "{not json}\n";
	stream.write(a.slice(0, 7));
	stream.write(`${a.slice(7)}${b}`);
	stream.write(c.slice(0, c.length - 4));
	stream.write(`${c.slice(c.length - 4)}${d.slice(0, 3)}`);
	stream.write(`${d.slice(3)}${bad}`);
	stream.end();

	await new Promise((resolve) => stream.on("end", resolve));
	detach();

	const checks = {
		lines: received.length,
		firstParsesWithU2028: received[0]?.payload === "a\u2028b",
		crlfStripped: received.some((l) => l.payload === "crlf"),
		bothChunkedRecords: received.some((l) => l.n === 1) && received.some((l) => l.n === 2),
		badJsonIsError: errors.length === 1 && errors[0] === "{not json}",
	};
	checks.ok =
		checks.firstParsesWithU2028 &&
		checks.crlfStripped &&
		checks.bothChunkedRecords &&
		checks.badJsonIsError;
	record("framing-adapter-corpus", checks.ok, checks);
}

// --- 3. End-to-end: spawn pinned rpc-entry, one command, verify LF framing -
{
	const agentDir = await mkdtemp(join(tmpdir(), "bear-m0-rpc-"));
	const child = spawn(process.execPath, [RPC_ENTRY], {
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			PI_DISABLE_TELEMETRY: "1",
			PI_CODING_AGENT: "true",
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	let stdout = "";
	const stderrChunks = [];
	child.stdout.on("data", (c) => (stdout += c));
	child.stderr.on("data", (c) => {
		stderrChunks.push(c.toString());
	});

	// Wait for any initial output, then issue get_state and expect a response.
	await new Promise((r) => setTimeout(r, 2500));
	child.stdin.write(`${JSON.stringify({ id: "spike-1", type: "get_state" })}\n`);
	await new Promise((r) => setTimeout(r, 3000));
	child.stdin.end();
	// RPC mode keeps running after stdin EOF; kill the process tree explicitly.
	child.kill("SIGTERM");
	const exitCode = await new Promise((r) => child.on("exit", r));

	const lines = stdout.split("\n").filter((l) => l.length > 0);
	const parsed = [];
	let framingOk = true;
	for (const l of lines) {
		try {
			parsed.push(JSON.parse(l));
		} catch {
			framingOk = false; // any non-JSON line = framing violation
		}
	}
	const response = parsed.find((p) => p.type === "response" && p.id === "spike-1");
	const checks = {
		everyLineParsesAsJson: framingOk,
		gotResponse: !!response,
		responseSuccess: response?.success === true,
		responseCommand: response?.command,
		killedAfterStdinEof: exitCode !== 0, // SIGTERM after stdin EOF is the expected lifecycle
		stderrBounded: stderrChunks.length < 200,
	};
	checks.ok =
		checks.everyLineParsesAsJson &&
		checks.gotResponse &&
		checks.responseSuccess &&
		checks.killedAfterStdinEof;
	record("rpc-entry-end-to-end", checks.ok, checks);
	await rm(agentDir, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
const allOk = report.every((r) => r.ok);
console.log(`\nM0 rpc framing spike: ${allOk ? "PASS" : "FAIL"}`);
process.exit(allOk ? 0 : 1);
