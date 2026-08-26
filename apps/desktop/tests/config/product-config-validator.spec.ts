// @vitest-environment node

import { validateProductConfig } from "@bear-harness/product-config";
import { describe, expect, it } from "vitest";
import { OFFICIAL_BRAND } from "../../scripts/official-brand.mjs";
import { FORK_PRODUCT, OFFICIAL_PRODUCT } from "../fixtures";

/**
 * Pure shape-contract tests for the shared runtime validator. These exercise
 * the package-level validator directly (filesystem checks are the desktop
 * wrapper's job and are covered by validate-product-config.spec.ts).
 */
describe("product-config validator (shared pure contract)", () => {
	it("pins the exact Bear Harness official identity and attribution", () => {
		expect(OFFICIAL_PRODUCT).toEqual({
			productName: "Bear Harness",
			appId: "io.github.fltb.bear-harness",
			dataDirectoryName: "bear-harness",
			artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
			executableName: "bear-harness",
			defaultCharacterId: "jizhou",
			brandLicense: {
				spdx: "CC-BY-SA-4.0",
				workTitle: "Bear Harness Brand Assets",
				creator: "fltb",
				attribution: "fltb — 白熊客栈 / Bear Harness Brand Assets",
				sourceUrl: "https://github.com/fltb/bear-harness",
				modified: false,
				modificationNotice: "",
			},
			icon: "packages/product-config/assets/icon.png",
			updateFeedUrl: "",
		});
		expect(OFFICIAL_BRAND).toEqual({
			productName: "Bear Harness",
			appId: "io.github.fltb.bear-harness",
			dataDirectoryName: "bear-harness",
			artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
			executableName: "bear-harness",
			defaultCharacterId: "jizhou",
			brandLicense: OFFICIAL_PRODUCT.brandLicense,
			icon: "packages/product-config/assets/icon.png",
		});
	});

	it("accepts the official config against the official reference", () => {
		expect(validateProductConfig(OFFICIAL_PRODUCT, OFFICIAL_BRAND)).toEqual([]);
	});

	it("accepts a complete fork config with a shipped character package", () => {
		expect(validateProductConfig(FORK_PRODUCT, OFFICIAL_BRAND)).toEqual([]);
	});

	it("treats a brand-only change as a fork identity change", () => {
		const brandOnly = {
			...OFFICIAL_PRODUCT,
			brandLicense: {
				...OFFICIAL_PRODUCT.brandLicense,
				workTitle: "Renamed Brand Assets",
				creator: "Fork Studio",
			},
		};
		const fields = validateProductConfig(brandOnly, OFFICIAL_BRAND).map((error) => error.field);
		// Keeping the official appId/dataDirectoryName while changing identity is
		// rejected, and the modification declaration must be truthful.
		expect(fields).toEqual(
			expect.arrayContaining(["brandLicense.modified", "appId", "dataDirectoryName"]),
		);
	});

	it("rejects an icon that is undefined instead of null (aligns with string|null)", () => {
		const { icon: _icon, ...withoutIcon } = OFFICIAL_PRODUCT;
		const errors = validateProductConfig(withoutIcon, OFFICIAL_BRAND);
		expect(errors.map((error) => error.field)).toContain("icon");
	});

	it("rejects icon paths that escape the repository", () => {
		const errors = validateProductConfig(
			{ ...OFFICIAL_PRODUCT, icon: "../outside/icon.png" },
			OFFICIAL_BRAND,
		);
		expect(errors.map((error) => error.field)).toContain("icon");
	});

	it("rejects a bad update feed URL", () => {
		const errors = validateProductConfig(
			{ ...FORK_PRODUCT, updateFeedUrl: "http://insecure.example.com/feed.json" },
			OFFICIAL_BRAND,
		);
		expect(errors.map((error) => error.field)).toContain("updateFeedUrl");
	});

	it("rejects a non-empty update feed without publisher authentication", () => {
		const errors = validateProductConfig(
			{ ...FORK_PRODUCT, updateFeedUrl: "https://example.com/feed.json" },
			OFFICIAL_BRAND,
		);
		expect(errors.map((error) => error.field)).toContain("updatePublisher");
	});

	it("accepts an authenticated HTTPS feed", () => {
		const errors = validateProductConfig(
			{
				...FORK_PRODUCT,
				updateFeedUrl: "https://example.com/feed.json",
				updatePublisher: {
					algorithm: "ed25519",
					publicKey:
						"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAu1l3Gg9mWg9mWg9mWg9mWg9mWg9mWg9mWg9mWg9mWg9mWg9m\n-----END PUBLIC KEY-----\n",
				},
			},
			OFFICIAL_BRAND,
		);
		expect(errors).toEqual([]);
	});

	it("keeps the empty feed valid and disabled", () => {
		const errors = validateProductConfig({ ...FORK_PRODUCT, updateFeedUrl: "" }, OFFICIAL_BRAND);
		expect(errors).toEqual([]);
	});
});
