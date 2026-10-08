import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { webLaunchArguments } from "./web-launch-mode.mjs";

test("soak acceptance serves the production build without opening a browser", () => {
	assert.deepEqual(webLaunchArguments(true), ["--no-install", "rsbuild", "preview"]);
	assert.deepEqual(webLaunchArguments(false), ["--no-install", "rsbuild", "dev"]);
});

test("production build uses the selected Node without shell interpolation and reports spawn failures", () => {
	const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "build.mjs"), "utf8");
	assert.ok(source.includes("spawnSync(process.execPath, args"));
	assert.ok(source.includes("process.env.npm_execpath"));
	assert.ok(source.includes("if (result.error) throw result.error"));
	assert.ok(!source.includes("shell:"));
});
