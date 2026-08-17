import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
	join(repoRoot, "apps/web-dev/server"),
	join(repoRoot, "apps/web-dev/src"),
	join(repoRoot, "apps/web-dev/scripts"),
];
const forbidden = [/\bE2E_[A-Z0-9_]+\b/, /\be2e-rule\b/i, /\bruleProvider\b/];
const findings = [];

function collect(directory) {
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) collect(path);
		else if (/\.(?:[cm]?[jt]s|tsx)$/.test(path)) {
			for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
				const match = forbidden.find((pattern) => pattern.test(line));
				if (match) findings.push(`${relative(repoRoot, path)}:${index + 1} ${match}`);
			}
		}
	}
}

for (const root of roots) collect(root);
if (findings.length) {
	process.stderr.write(
		`WebDev production code contains test-only markers:\n${findings.join("\n")}\n`,
	);
	process.exit(1);
}
