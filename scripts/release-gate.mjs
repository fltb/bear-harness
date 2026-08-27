import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";

if (process.env.CI !== "true") {
	throw new Error(
		"The complete release gate runs in the protected CI matrix; dispatch bear-harness-ci",
	);
}
if (existsSync("release-attestations"))
	rmSync("release-attestations", { recursive: true, force: true });
mkdirSync("release-attestations", { recursive: true });

const stages = [
	["lint", ["run", "lint"]],
	["typecheck", ["run", "typecheck"]],
	["coverage", ["run", "test:coverage"]],
	["build", ["run", "build"]],
	["recovery", ["run", "test:release:recovery"]],
	["web-e2e", ["run", "test:e2e:web:required"]],
	["electron-e2e", ["run", "test:e2e:electron"]],
];
for (const [name, args] of stages) {
	console.log(`\n=== release gate: ${name} ===`);
	const result = spawnSync("npm", args, { stdio: "inherit", env: process.env });
	if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
	"Source/platform-independent release gate stages passed; CI still requires live-model and all package targets",
);
