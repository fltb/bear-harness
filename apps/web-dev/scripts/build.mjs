import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const workspace of [
	"@bear-harness/product-config",
	"@bear-harness/protocol",
	"@bear-harness/companion-client",
	"@bear-harness/host-runtime",
	"@bear-harness/companion-ui",
]) {
	const result = spawnSync("npm", ["run", "build", "--workspace", workspace], {
		cwd: repoRoot,
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const result = spawnSync("npx", ["--no-install", "rsbuild", "build"], {
	stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);
