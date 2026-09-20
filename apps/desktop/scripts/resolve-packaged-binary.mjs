/**
 * Locates the unpacked packaged binary from @bear-harness/product-config and
 * runs the packaged smoke with BEAR_PACKAGED_BINARY set.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { resolvePackagedBinary } from "./packaged-binary.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(desktop, "release");
const require = createRequire(import.meta.url);
const playwrightCli = join(dirname(require.resolve("playwright/package.json")), "cli.js");

const binary = resolvePackagedBinary(
	releaseDir,
	process.platform,
	process.arch,
	productConfig.executableName,
);

process.stderr.write(`packaged binary: ${binary}\n`);
const result = spawnSync(
	process.execPath,
	[playwrightCli, "test", "packaged.spec.ts", "--config=playwright.packaged.config.ts"],
	{
		cwd: desktop,
		env: { ...process.env, BEAR_PACKAGED_BINARY: binary },
		stdio: "inherit",
	},
);
process.exit(result.status ?? 1);
