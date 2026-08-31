import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const obsoleteName = /cyber(?:[ -]?bear)/giu;

const archivedDocsPrefix = "docs/archive/";

const textExtensions = new Set([
	".bash",
	".bat",
	".c",
	".cc",
	".cjs",
	".conf",
	".cpp",
	".cs",
	".css",
	".cts",
	".env",
	".example",
	".fish",
	".go",
	".gql",
	".graphql",
	".h",
	".htm",
	".html",
	".ini",
	".java",
	".js",
	".json",
	".jsonc",
	".jsx",
	".kt",
	".less",
	".md",
	".mdx",
	".mjs",
	".mts",
	".plist",
	".ps1",
	".py",
	".rs",
	".scss",
	".sh",
	".sql",
	".svg",
	".swift",
	".toml",
	".ts",
	".tsx",
	".txt",
	".xml",
	".yaml",
	".yml",
	".zsh",
]);
const textFileNames = new Set(["Dockerfile", "Gemfile", "Justfile", "Makefile", "Procfile"]);

function repositoryFiles() {
	const output = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	return output
		.split("\0")
		.filter(Boolean)
		.filter((repoPath) => !repoPath.startsWith(archivedDocsPrefix));
}

function shouldScanFile(path) {
	const name = path.slice(path.lastIndexOf(sep) + 1);
	return (
		textExtensions.has(extname(name).toLowerCase()) ||
		textFileNames.has(name) ||
		name.startsWith(".")
	);
}

const findings = [];

for (const repoPath of repositoryFiles()) {
	const path = resolve(repoRoot, repoPath);
	if (!existsSync(path) || !shouldScanFile(path)) continue;

	for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/u).entries()) {
		obsoleteName.lastIndex = 0;
		if (obsoleteName.test(line)) {
			findings.push(`${repoPath}:${index + 1}`);
		}
	}
}

if (findings.length > 0) {
	process.stderr.write(`Obsolete product-name violations:\n${findings.join("\n")}\n`);
	process.exit(1);
}

console.log("Obsolete product-name gate passed.");
