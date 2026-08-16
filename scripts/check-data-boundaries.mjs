import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const orchestrationModules = [
	"packages/host-runtime/src/composition.ts",
	"packages/host-runtime/src/runtime.ts",
];
const forbidden = [/\.prepare\s*\(/, /\.exec\s*\(/];
const findings = [];

for (const modulePath of orchestrationModules) {
	const absolutePath = resolve(repoRoot, modulePath);
	for (const [index, line] of readFileSync(absolutePath, "utf8").split("\n").entries()) {
		if (forbidden.some((pattern) => pattern.test(line))) {
			findings.push(`${relative(repoRoot, absolutePath)}:${index + 1}`);
		}
	}
}

if (findings.length > 0) {
	process.stderr.write(
		`RPC and runtime orchestration must use typed repositories or Drizzle services:\n${findings.join("\n")}\n`,
	);
	process.exit(1);
}
