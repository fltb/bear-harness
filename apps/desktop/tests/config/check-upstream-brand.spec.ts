// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORK_PRODUCT, OFFICIAL_PRODUCT } from "../fixtures";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
const upstreamGate = join(desktopRoot, "scripts/check-upstream-brand.mjs");

function writeFixture(dir: string, name: string, config: unknown): string {
	const file = join(dir, `${name}.ts`);
	writeFileSync(file, `export const productConfig = ${JSON.stringify(config)};\n`, "utf8");
	return file;
}

function runGate(fixturePath: string) {
	return spawnSync(process.execPath, [upstreamGate, fixturePath], { encoding: "utf8" });
}

describe("check-upstream-brand", () => {
	const dir = mkdtempSync(join(tmpdir(), "bear-upstream-"));

	it("passes the official config", () => {
		const file = writeFixture(dir, "official", OFFICIAL_PRODUCT);
		const result = runGate(file);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Upstream brand match");
	});

	it("fails when the default character id changes while reusing the official appId", () => {
		const config = {
			...OFFICIAL_PRODUCT,
			defaultCharacterId: "beixing",
		};
		const file = writeFixture(dir, "role-change", config);
		const result = runGate(file);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Upstream brand mismatch: defaultCharacterId");
	});

	it("fails when the release identity changes while reusing the official dataDirectoryName", () => {
		const config = { ...OFFICIAL_PRODUCT, appId: "io.example.cyber-bear-2" };
		const file = writeFixture(dir, "appid-change", config);
		const result = runGate(file);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Upstream brand mismatch: appId");
	});

	it("fails on a fork config (exact snapshot check)", () => {
		const file = writeFixture(dir, "fork", FORK_PRODUCT);
		const result = runGate(file);
		expect(result.status).not.toBe(0);
	});
});
