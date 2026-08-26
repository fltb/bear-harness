/**
 * Diagnostics policy/catalog integrity gate.
 *
 * Imports the production contracts module (Node 24 executes erasable
 * TypeScript directly) and asserts the policy values and catalog shape are
 * exactly the pinned v1 contract. Any drift fails with a fixed prefix.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsUrl = pathToFileURL(
	resolve(here, "../../../packages/host-runtime/src/diagnostics/contracts.ts"),
).href;

const EXPECTED_POLICY = {
	localOnly: true,
	contentMode: "metadata-only",
	maxAgeDays: 30,
	maxBytes: 209715200,
	segmentBytes: 5242880,
	queueMaxRecords: 500,
	queueMaxBytes: 1048576,
	shutdownFlushMs: 2000,
	rendererFaultsPerMinute: 20,
	crashUpload: false,
};

const EXPECTED_NAMES = [
	"app.session",
	"diagnostics.prune",
	"window.session",
	"window.load",
	"rpc.request",
	"webdev.rpc_dispatch_failure",
	"app.started",
	"app.previous_exit_unclean",
	"app.shutdown_timeout",
	"diagnostics.retention_deferred",
	"diagnostics.writer_recovered",
	"diagnostics.input_rejected",
	"diagnostics.trace_restarted",
	"window.load_failed",
	"window.unresponsive",
	"window.responsive",
	"preload.failed",
	"renderer.fault",
	"renderer.process_gone",
	"electron.child_process_gone",
	"main.uncaught_exception",
];

const SPAN_NAMES = [
	"app.session",
	"diagnostics.prune",
	"window.session",
	"window.load",
	"rpc.request",
];
const KINDS = ["event", "span"];
const LEVELS = ["info", "warn", "error", "fatal"];
const ORIGINS = ["main", "renderer", "electron"];
const ATTRIBUTE_TYPES = ["boolean", "integer", "string"];

function fail(message) {
	process.stderr.write(`Invalid diagnostics contracts: ${message}\n`);
	process.exit(1);
}

const { DIAGNOSTICS_POLICY, DIAGNOSTIC_CATALOG } = await import(contractsUrl);

if (!Object.isFrozen(DIAGNOSTICS_POLICY)) fail("DIAGNOSTICS_POLICY must be frozen");
for (const [key, value] of Object.entries(EXPECTED_POLICY)) {
	if (DIAGNOSTICS_POLICY[key] !== value) {
		fail(
			`DIAGNOSTICS_POLICY.${key} must be ${JSON.stringify(value)}, got ${JSON.stringify(DIAGNOSTICS_POLICY[key])}`,
		);
	}
}
const policyKeys = Object.keys(DIAGNOSTICS_POLICY).sort();
const expectedPolicyKeys = Object.keys(EXPECTED_POLICY).sort();
if (JSON.stringify(policyKeys) !== JSON.stringify(expectedPolicyKeys)) {
	fail("DIAGNOSTICS_POLICY has unexpected keys");
}

if (!Object.isFrozen(DIAGNOSTIC_CATALOG)) fail("DIAGNOSTIC_CATALOG must be frozen");
const catalogNames = Object.keys(DIAGNOSTIC_CATALOG).sort();
if (JSON.stringify(catalogNames) !== JSON.stringify([...EXPECTED_NAMES].sort())) {
	fail("catalog names do not match the pinned v1 list");
}

for (const name of EXPECTED_NAMES) {
	const entry = DIAGNOSTIC_CATALOG[name];
	if (!entry || typeof entry !== "object") fail(`${name}: missing entry`);
	if (!Object.isFrozen(entry)) fail(`${name}: entry must be frozen`);
	if (!KINDS.includes(entry.kind)) fail(`${name}: bad kind ${JSON.stringify(entry.kind)}`);
	if (!LEVELS.includes(entry.level)) fail(`${name}: bad level ${JSON.stringify(entry.level)}`);
	if (!ORIGINS.includes(entry.origin)) fail(`${name}: bad origin ${JSON.stringify(entry.origin)}`);
	if (SPAN_NAMES.includes(name)) {
		if (entry.kind !== "span") fail(`${name}: pinned span kind mismatch`);
		if (entry.level !== "info") fail(`${name}: pinned span base level must be info`);
		if (entry.origin !== "main") fail(`${name}: pinned span origin must be main`);
	} else if (entry.kind !== "event") {
		fail(`${name}: expected event kind`);
	}
	if (!entry.attributes || typeof entry.attributes !== "object")
		fail(`${name}: attributes missing`);
	for (const [key, spec] of Object.entries(entry.attributes)) {
		if (!ATTRIBUTE_TYPES.includes(spec.type)) fail(`${name}.${key}: bad attribute type`);
		if (spec.type === "integer") {
			if (typeof spec.min !== "number" || typeof spec.max !== "number") {
				fail(`${name}.${key}: integer spec requires min/max`);
			}
		}
		if (spec.type === "string") {
			if (!Array.isArray(spec.enum) && typeof spec.maxBytes !== "number") {
				fail(`${name}.${key}: string spec requires enum or maxBytes`);
			}
		}
		if (spec.optional !== undefined && typeof spec.optional !== "boolean") {
			fail(`${name}.${key}: optional must be a boolean`);
		}
	}
}

process.stdout.write("Diagnostics contracts: ok\n");
