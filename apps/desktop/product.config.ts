/**
 * Compile-time release identity and default character preset.
 *
 * This is the ONLY file a third-party fork needs to edit to build a fully
 * independent application: change the identity fields, brand license
 * declaration, icon and default character, then run `npm run build`.
 * The generic validator (`scripts/validate-product-config.mjs`) enforces that
 * any identity change also changes `appId` and `dataDirectoryName`, declares
 * `brandLicense.modified: true` and provides a modification notice.
 *
 * This file is erasable TypeScript: it uses only `type`/`interface` and plain
 * values, so it can be executed directly by Node 24 and by electron-builder.
 * It never reads environment variables or user files.
 */

export interface ProductCharacter {
	/** ASCII kebab-case id (^[a-z0-9]+(?:-[a-z0-9]+)*$). */
	id: string;
	name: string;
	subtitle: string;
	sceneTitle: string;
	greeting: string;
	oldStationTitle: string;
	oldStationGreeting: string;
}

export interface BrandLicense {
	/** Fixed: brand assets are CC BY-SA 4.0. */
	spdx: "CC-BY-SA-4.0";
	workTitle: string;
	creator: string;
	attribution: string;
	sourceUrl: string;
	/** True once any brand asset or identity field diverges from the official values. */
	modified: boolean;
	modificationNotice: string;
}

export interface ProductConfig {
	/** System install name and native window title fallback. */
	productName: string;
	/** Reverse-domain id; also used as the Linux desktop entry name. */
	appId: string;
	/** ASCII kebab-case; Electron `userData` subdirectory name under appData. */
	dataDirectoryName: string;
	/** electron-builder artifact macro template. */
	artifactName: string;
	/** ASCII kebab-case executable name. */
	executableName: string;
	defaultCharacter: ProductCharacter;
	brandLicense: BrandLicense;
	/** Repo-root-relative path to a 1024x1024 PNG or a readable SVG, or null for the default icon. */
	icon: string | null;
}

export const productConfig: ProductConfig = {
	productName: "Cyber Bear",
	appId: "io.github.fltb.bear-harness",
	dataDirectoryName: "cyber-bear",
	artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
	executableName: "cyber-bear",
	defaultCharacter: {
		id: "jizhou",
		name: "极昼",
		subtitle: "旧极光站的守望者",
		sceneTitle: "极光书房 · 雪停以后",
		greeting: "你回来了。今晚是想说会儿话，还是有东西要我替你看着？",
		oldStationTitle: "旧站留下的记录",
		oldStationGreeting:
			"我曾信过一次没有依据的“已经修好”。后来档案丢了。所以现在，不知道就是不知道。",
	},
	brandLicense: {
		spdx: "CC-BY-SA-4.0",
		workTitle: "Cyber Bear Brand Assets",
		creator: "fltb",
		attribution: "fltb — Cyber Bear Brand Assets",
		sourceUrl: "https://github.com/fltb/bear-harness",
		modified: false,
		modificationNotice: "",
	},
	icon: null,
};
