// @vitest-environment node

import { describe, expect, it } from "vitest";
import { checkUpstreamBrand } from "../../scripts/check-upstream-brand.mjs";
import { FORK_PRODUCT, OFFICIAL_PRODUCT } from "../fixtures";

describe("check-upstream-brand", () => {
	it("passes the official config", () => {
		expect(checkUpstreamBrand(OFFICIAL_PRODUCT)).toBeNull();
	});

	it("fails when the default character id changes while reusing the official appId", () => {
		const config = {
			...OFFICIAL_PRODUCT,
			defaultCharacterId: "beixing",
		};
		expect(checkUpstreamBrand(config)).toBe("defaultCharacterId");
	});

	it("fails when the release identity changes while reusing the official dataDirectoryName", () => {
		const config = { ...OFFICIAL_PRODUCT, appId: "io.example.bear-harness-2" };
		expect(checkUpstreamBrand(config)).toBe("appId");
	});

	it("fails on a fork config (exact snapshot check)", () => {
		expect(checkUpstreamBrand(FORK_PRODUCT)).not.toBeNull();
	});
});
