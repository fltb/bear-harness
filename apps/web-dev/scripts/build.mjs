import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
for (const workspace of [
	"@bear-harness/product-config",
	"@bear-harness/protocol",
	"@bear-harness/companion-client",
	"@bear-harness/host-runtime",
	"@bear-harness/companion-ui",
]) {
	const result = spawnSync(npmCommand, ["run", "build", "--workspace", workspace], {
		cwd: repoRoot,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const result = spawnSync(npxCommand, ["--no-install", "rsbuild", "build"], {
	stdio: "inherit",
	shell: process.platform === "win32",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
