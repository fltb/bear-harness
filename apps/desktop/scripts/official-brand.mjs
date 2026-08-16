/**
 * Official upstream brand snapshot.
 *
 * Shared by the generic validator (fork identity rules) and the upstream
 * release gate (exact-equality check). Kept as plain JS data so neither
 * script imports the repo's own product.config.ts for its constants.
 */

export const OFFICIAL_BRAND = Object.freeze({
	productName: "Cyber Bear",
	appId: "io.github.fltb.bear-harness",
	dataDirectoryName: "cyber-bear",
	artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
	executableName: "cyber-bear",
	defaultCharacterId: "jizhou",
	brandLicense: Object.freeze({
		spdx: "CC-BY-SA-4.0",
		workTitle: "Cyber Bear Brand Assets",
		creator: "fltb",
		attribution: "fltb — Cyber Bear Brand Assets",
		sourceUrl: "https://github.com/fltb/bear-harness",
		modified: false,
		modificationNotice: "",
	}),
	icon: "packages/product-config/assets/icon.png",
});
