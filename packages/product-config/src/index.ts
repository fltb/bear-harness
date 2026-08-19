/** Compile-time release identity and default character preset. */
export interface BrandLicense {
	spdx: "CC-BY-SA-4.0";
	workTitle: string;
	creator: string;
	attribution: string;
	sourceUrl: string;
	modified: boolean;
	modificationNotice: string;
}

export interface ProductConfig {
	productName: string;
	appId: string;
	dataDirectoryName: string;
	artifactName: string;
	executableName: string;
	defaultCharacterId: string;
	brandLicense: BrandLicense;
	icon: string | null;
	/**
	 * Optional JSON update feed URL for the desktop auto-update service.
	 * Empty string (the default) disables update checks entirely.
	 * Feed format: a JSON array of `{ version, url, sha256 }` entries (newest
	 * compatible version is picked by numeric major.minor.patch comparison) or
	 * a single such object. `sha256: null` explicitly marks a checksum as
	 * absent; a missing field rejects the entry at runtime.
	 */
	updateFeedUrl?: string;
}

export const productConfig: ProductConfig = {
	productName: "Cyber Bear",
	appId: "io.github.fltb.bear-harness",
	dataDirectoryName: "cyber-bear",
	artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
	executableName: "cyber-bear",
	defaultCharacterId: "jizhou",
	brandLicense: {
		spdx: "CC-BY-SA-4.0",
		workTitle: "Cyber Bear Brand Assets",
		creator: "fltb",
		attribution: "fltb — Cyber Bear Brand Assets",
		sourceUrl: "https://github.com/fltb/bear-harness",
		modified: false,
		modificationNotice: "",
	},
	icon: "packages/product-config/assets/icon.png",
	updateFeedUrl: "",
};
