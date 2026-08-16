import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [
	join(repoRoot, "packages/companion-ui/src"),
	join(repoRoot, "apps/web-dev/src"),
];
const sourceFiles = [];

function collect(directory) {
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) collect(path);
		else if (path.endsWith(".ts") || path.endsWith(".tsx")) sourceFiles.push(path);
	}
}

for (const root of sourceRoots) collect(root);

const findings = [];
const forbiddenI18nPatterns = [
	[/@bear-harness\/product-config\/locales/, "locale catalogs belong to @bear-harness/i18n"],
	[/@solid-primitives\/i18n/, "use the shared i18next instance"],
	[/from\s+["']\.\.?\/[^"']*i18n(?:\.[jt]s)?["']/, "do not add a UI-local i18n facade"],
];
for (const path of sourceFiles) {
	let inBlockComment = false;
	for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
		const trimmed = line.trim();
		if (inBlockComment) {
			if (trimmed.includes("*/")) inBlockComment = false;
			continue;
		}
		if (trimmed.startsWith("/*")) {
			if (!trimmed.includes("*/")) inBlockComment = true;
			continue;
		}
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
		if (/[\p{Script=Han}]/u.test(line)) findings.push(`${relative(repoRoot, path)}:${index + 1}`);
		for (const [pattern, reason] of forbiddenI18nPatterns) {
			if (pattern.test(line)) findings.push(`${relative(repoRoot, path)}:${index + 1} ${reason}`);
		}
	}
}

if (findings.length > 0) {
	process.stderr.write(`UI copy and locale ownership violations:\n${findings.join("\n")}\n`);
	process.exit(1);
}
