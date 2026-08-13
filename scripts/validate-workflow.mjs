/**
 * Root gate: validates .github/workflows/ci.yml with yaml's parseDocument
 * (catches duplicate keys and syntax errors) and requires the top-level
 * `name`, `on` and a non-empty `jobs` map.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(here, "../.github/workflows/ci.yml");

let source;
try {
	source = readFileSync(workflowPath, "utf8");
} catch (error) {
	process.stderr.write(
		`Invalid workflow: cannot read ${workflowPath}: ${String(error?.message ?? error)}\n`,
	);
	process.exit(1);
}

const doc = parseDocument(source);
if (doc.errors.length > 0) {
	for (const error of doc.errors) {
		process.stderr.write(`Invalid workflow: ${error.message}\n`);
	}
	process.exit(1);
}

const data = doc.toJS();
if (data === null || typeof data !== "object") {
	process.stderr.write("Invalid workflow: document root must be a mapping\n");
	process.exit(1);
}
if (typeof data.name !== "string" || data.name.trim() === "") {
	process.stderr.write("Invalid workflow: top-level `name` must be a non-empty string\n");
	process.exit(1);
}
if (!data.on || typeof data.on !== "object") {
	process.stderr.write("Invalid workflow: top-level `on` must be a mapping\n");
	process.exit(1);
}
if (!data.jobs || typeof data.jobs !== "object" || Object.keys(data.jobs).length === 0) {
	process.stderr.write("Invalid workflow: top-level `jobs` must be a non-empty mapping\n");
	process.exit(1);
}

process.stdout.write(`Workflow valid: ${workflowPath}\n`);
