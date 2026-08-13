import type { ProductConfig } from "../product.config";
import { productConfig as officialConfig } from "../product.config";

/** The official product config as shipped. */
export const OFFICIAL_PRODUCT: Readonly<ProductConfig> = officialConfig;

/**
 * A complete fork fixture: different identity fields, data directory,
 * executable, character and brand modification declaration. The generic
 * validator accepts this config (verified in the config tests).
 */
export const FORK_PRODUCT: Readonly<ProductConfig> = {
	productName: "North Companion",
	appId: "io.example.north-companion",
	dataDirectoryName: "north-companion",
	artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
	executableName: "north-companion",
	defaultCharacter: {
		id: "beixing",
		name: "北星",
		subtitle: "极地信号站的守灯人",
		sceneTitle: "灯塔 · 夜航未竟",
		greeting: "你回来了。今晚是要守灯，还是只想坐一会儿？",
		oldStationTitle: "旧信号站",
		oldStationGreeting: "旧信号站的灯灭了三年。后来它重新亮起时，我不再相信没人说过的话。",
	},
	brandLicense: {
		spdx: "CC-BY-SA-4.0",
		workTitle: "North Companion Brand Assets",
		creator: "North Studio",
		attribution: "North Studio — North Companion Brand Assets",
		sourceUrl: "https://example.com/north-companion",
		modified: true,
		modificationNotice:
			"Renamed app, character replaced with 北星; UI copy adapted for the North Companion release.",
	},
	icon: null,
};
