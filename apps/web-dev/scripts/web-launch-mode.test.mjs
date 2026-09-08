import assert from "node:assert/strict";
import test from "node:test";
import { webLaunchArguments } from "./web-launch-mode.mjs";

test("soak acceptance serves the production build without opening a browser", () => {
	assert.deepEqual(webLaunchArguments(true), ["--no-install", "rsbuild", "preview"]);
	assert.deepEqual(webLaunchArguments(false), ["--no-install", "rsbuild", "dev"]);
});
