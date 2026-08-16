import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(repoRoot, "packages/host-runtime/src");
const allowedRawDatabaseModule = resolve(sourceRoot, "storage/database.ts");
const forbidden = [
	/import\s+(?:type\s+)?[^;]*from\s+["']node:sqlite["']/,
	/\.prepare\s*\(/,
	/(?:\bdb|this\.db|\bconnection|this\.connection)\.exec\s*\(/,
];
const findings = [];

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return extname(entry.name) === ".ts" ? [path] : [];
	});
}

for (const absolutePath of sourceFiles(sourceRoot)) {
	if (absolutePath === allowedRawDatabaseModule) continue;
	for (const [index, line] of readFileSync(absolutePath, "utf8").split("\n").entries()) {
		if (forbidden.some((pattern) => pattern.test(line))) {
			findings.push(`${relative(repoRoot, absolutePath)}:${index + 1}`);
		}
	}
}

if (findings.length > 0) {
	process.stderr.write(
		`Host business modules must use Drizzle; raw SQLite is restricted to storage/database.ts:\n${findings.join("\n")}\n`,
	);
	process.exit(1);
}
