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
};
