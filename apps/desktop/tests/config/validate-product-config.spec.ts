// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORK_PRODUCT, OFFICIAL_PRODUCT } from "../fixtures";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
const validator = join(desktopRoot, "scripts/validate-product-config.mjs");

function writeFixture(dir: string, name: string, config: unknown): string {
	const file = join(dir, `${name}.ts`);
	writeFileSync(file, `export const productConfig = ${JSON.stringify(config)};\n`, "utf8");
	return file;
}

function runValidator(fixturePath: string) {
	return spawnSync(process.execPath, [validator, fixturePath, "--no-write"], {
		encoding: "utf8",
	});
}

describe("validate-product-config", () => {
	const dir = mkdtempSync(join(tmpdir(), "bear-config-"));

	it("accepts the official config", () => {
		const file = writeFixture(dir, "official", OFFICIAL_PRODUCT);
		const result = runValidator(file);
		expect(result.status).toBe(0);
	});

	it("accepts a complete fork config", () => {
		const file = writeFixture(dir, "fork", FORK_PRODUCT);
		const result = runValidator(file);
		expect(result.status).toBe(0);
	});

	it.each([
		["bad appId", { ...OFFICIAL_PRODUCT, appId: "bad" }, "appId"],
		[
			"missing artifact macro",
			{ ...OFFICIAL_PRODUCT, artifactName: "${productName}-${version}-${os}.${ext}" },
			"artifactName",
		],
		[
			"wrong CC SPDX",
			{ ...OFFICIAL_PRODUCT, brandLicense: { ...OFFICIAL_PRODUCT.brandLicense, spdx: "MIT" } },
			"brandLicense.spdx",
		],
		[
			"modified without notice",
			{ ...FORK_PRODUCT, brandLicense: { ...FORK_PRODUCT.brandLicense, modificationNotice: "" } },
			"brandLicense.modificationNotice",
		],
		["nonexistent icon", { ...FORK_PRODUCT, icon: "assets/does-not-exist.png" }, "icon"],
	])("rejects %s with the fixed prefix", (_label, config, field) => {
		const file = writeFixture(dir, "invalid", config);
		const result = runValidator(file);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(`Invalid product config: ${field}:`);
	});

	it("rejects an identity change that keeps the official appId", () => {
		const config = { ...OFFICIAL_PRODUCT, productName: "Renamed" };
		const file = writeFixture(dir, "same-appid", config);
		const result = runValidator(file);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Invalid product config: appId:");
	});

	it("rejects a non-1024x1024 PNG icon", () => {
		const repoRoot = resolve(desktopRoot, "../..");
		const relative = `apps/desktop/tests/.tmp-small-icon-${Date.now()}.png`;
		const pngPath = join(repoRoot, relative);
		// Minimal PNG header claiming 8x8 (wrong size).
		writeFileSync(
			pngPath,
			Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
				0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x08, 0x06, 0x00, 0x00, 0x00,
			]),
		);
		try {
			const config = { ...FORK_PRODUCT, icon: relative };
			const file = writeFixture(dir, "small-icon", config);
			const result = runValidator(file);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Invalid product config: icon:");
		} finally {
			rmSync(pngPath, { force: true });
		}
	});
});
