// @vitest-environment node

import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateProductConfig } from "../../scripts/validate-product-config.mjs";
import { FORK_PRODUCT, OFFICIAL_PRODUCT } from "../fixtures";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
describe("validate-product-config", () => {
	it("accepts the official config", () => {
		expect(validateProductConfig(OFFICIAL_PRODUCT)).toEqual([]);
	});

	it("accepts a complete fork config", () => {
		expect(validateProductConfig(FORK_PRODUCT)).toEqual([]);
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
		expect(validateProductConfig(config).map((error) => error.field)).toContain(field);
	});

	it("rejects an identity change that keeps the official appId", () => {
		const config = { ...OFFICIAL_PRODUCT, productName: "Renamed" };
		expect(validateProductConfig(config).map((error) => error.field)).toContain("appId");
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
			expect(validateProductConfig(config).map((error) => error.field)).toContain("icon");
		} finally {
			rmSync(pngPath, { force: true });
		}
	});
});
