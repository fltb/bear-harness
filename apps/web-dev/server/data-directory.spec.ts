import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
	desktopDataDirectory,
	webDevDataDirectory,
	webDevDataScopeDirectory,
} from "./data-directory.ts";

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
	assert.equal(
		webDevDataDirectory("cyber-bear", "/test-results/e2e-data", "linux", {}, "/home/user"),
		resolve("/test-results/e2e-data"),
	);
});

test("an explicitly isolated web-dev directory is scoped to the launcher process", () => {
	const first = webDevDataDirectory(
		"cyber-bear",
		"/test-results/e2e-data",
		"linux",
		{ BEAR_WEB_DEV_DATA_SCOPE: "101" },
		"/home/user",
	);
	const second = webDevDataDirectory(
		"cyber-bear",
		"/test-results/e2e-data",
		"linux",
		{ BEAR_WEB_DEV_DATA_SCOPE: "202" },
		"/home/user",
	);
	assert.equal(first, resolve("/test-results/e2e-data/.process-101"));
	assert.equal(second, resolve("/test-results/e2e-data/.process-202"));
	assert.notEqual(first, second);
});

test("scoped data roots require an explicit safe launcher scope", () => {
	assert.equal(
		webDevDataScopeDirectory("/test-results/e2e-data", "launcher-101"),
		resolve("/test-results/e2e-data/.process-launcher-101"),
	);
	assert.equal(webDevDataScopeDirectory("/test-results/e2e-data", undefined), undefined);
	assert.equal(webDevDataScopeDirectory("/test-results/e2e-data", ""), undefined);
	assert.equal(webDevDataScopeDirectory("/test-results/e2e-data", "../escape"), undefined);
	assert.equal(webDevDataScopeDirectory(undefined, "101"), undefined);
});
