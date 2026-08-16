import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { desktopDataDirectory } from "./data-directory.ts";

test("normal web development uses the same platform directory as Electron userData", () => {
	assert.equal(
		desktopDataDirectory("cyber-bear", undefined, "linux", {}, "/home/user"),
		resolve("/home/user/.config/cyber-bear"),
	);
	assert.equal(
		desktopDataDirectory(
			"cyber-bear",
			undefined,
			"linux",
			{ XDG_CONFIG_HOME: "/xdg/config" },
			"/home/user",
		),
		resolve("/xdg/config/cyber-bear"),
	);
	assert.equal(
		desktopDataDirectory("cyber-bear", undefined, "darwin", {}, "/Users/user"),
		resolve("/Users/user/Library/Application Support/cyber-bear"),
	);
	assert.equal(
		desktopDataDirectory(
			"cyber-bear",
			undefined,
			"win32",
			{ APPDATA: "/Users/user/AppData/Roaming" },
			"/Users/user",
		),
		resolve("/Users/user/AppData/Roaming/cyber-bear"),
	);
});

test("an explicit E2E data directory remains isolated", () => {
	assert.equal(
		desktopDataDirectory("cyber-bear", "/test-results/e2e-data", "linux", {}, "/home/user"),
		resolve("/test-results/e2e-data"),
	);
});
