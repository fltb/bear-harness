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
	defaultCharacter: Object.freeze({
		id: "jizhou",
		name: "极昼",
		subtitle: "旧极光站的守望者",
		sceneTitle: "极光书房 · 雪停以后",
		greeting: "你回来了。今晚是想说会儿话，还是有东西要我替你看着？",
		oldStationTitle: "旧站留下的记录",
		oldStationGreeting:
			"我曾信过一次没有依据的“已经修好”。后来档案丢了。所以现在，不知道就是不知道。",
	}),
	brandLicense: Object.freeze({
		spdx: "CC-BY-SA-4.0",
		workTitle: "Cyber Bear Brand Assets",
		creator: "fltb",
		attribution: "fltb — Cyber Bear Brand Assets",
		sourceUrl: "https://github.com/fltb/bear-harness",
		modified: false,
		modificationNotice: "",
	}),
	icon: null,
});
