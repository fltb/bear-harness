/**
 * electron-builder configuration. @bear-harness/product-config is the single
 * source of release identity, so UI title and installation identity cannot drift.
 *
 * - Linux desktop entry Name = productName; `desktopName` in the package
 *   metadata is overridden to appId via extraMetadata (so the .desktop
 *   filename, StartupWMClass and Electron's app_id all match), with
 *   `syncDesktopName: true`.
 * - Extra resources ship the two licenses and the generated brand
 *   attribution; only `dist/**` goes into the asar.
 * - Official artifacts are unsigned framework builds: `mac.identity: null`,
 *   `afterSign: null`, no notarize, no certificates. Forks sign through
 *   their own CI by injecting the standard electron-builder credential
 *   environment variables.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import type { Configuration } from "electron-builder";
import { prepareZip, writeZip } from "./scripts/package-zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const attributionPath = resolve(here, "dist/brand/BRAND-ATTRIBUTION.txt");
if (!existsSync(attributionPath)) {
	throw new Error(
		"Missing generated brand attribution. Run `node scripts/validate-product-config.mjs` before electron-builder.",
	);
}
// Icon paths in the shared product config are repo-root-relative.
const icon = productConfig.icon ? resolve(repoRoot, productConfig.icon) : undefined;

function resolvePlatformIcon(extension: ".icns" | ".ico") {
	if (!productConfig.icon?.endsWith(".png")) return undefined;
	const path = resolve(repoRoot, `${productConfig.icon.slice(0, -4)}${extension}`);
	if (!existsSync(path)) {
		throw new Error(`Missing committed ${extension} brand icon: ${path}`);
	}
	return path;
}

const macIcon = resolvePlatformIcon(".icns");
const windowsIcon = resolvePlatformIcon(".ico");

const productionExcludes = [
	"!dist/main/node_modules/**/*",
	"!dist/**/*.map",
	"!dist/**/*.d.ts",
	"!dist/**/*.tsbuildinfo",
	"!node_modules/@openai/codex*/**/*",
	"!node_modules/@tencentdb-agent-memory/**/*",
	"!node_modules/tesseract.js/**/*",
	"!node_modules/tesseract.js-core/**/*",
	"!node_modules/officeparser/dist/officeparser.browser*",
	"!node_modules/node-llama-cpp/llama/gitRelease.bundle",
	"!node_modules/pdfjs-dist/build/**/*",
	"!node_modules/pdfjs-dist/web/**/*",
	"!**/*.map",
	"!**/*.d.ts",
	"!**/*.tsbuildinfo",
];

const nativePackageExcludes = {
	mac: [
		"!node_modules/@node-llama-cpp/linux-*/**/*",
		"!node_modules/@node-llama-cpp/win-*/**/*",
		"!node_modules/**/@mariozechner/clipboard-linux-*/**/*",
		"!node_modules/**/@mariozechner/clipboard-win32-*/**/*",
	],
	win: [
		"!node_modules/@node-llama-cpp/linux-*/**/*",
		"!node_modules/@node-llama-cpp/mac-*/**/*",
		"!node_modules/@node-llama-cpp/win-arm64/**/*",
		"!node_modules/@node-llama-cpp/win-x64-cuda/**/*",
		"!node_modules/@node-llama-cpp/win-x64-cuda-ext/**/*",
		"!node_modules/@node-llama-cpp/win-x64-vulkan/**/*",
		"!node_modules/**/@mariozechner/clipboard-darwin-*/**/*",
		"!node_modules/**/@mariozechner/clipboard-linux-*/**/*",
		"!node_modules/**/@mariozechner/clipboard-win32-arm64/**/*",
	],
	linux: [
		"!node_modules/@node-llama-cpp/mac-*/**/*",
		"!node_modules/@node-llama-cpp/win-*/**/*",
		"!node_modules/@node-llama-cpp/linux-arm64/**/*",
		"!node_modules/@node-llama-cpp/linux-armv7l/**/*",
		"!node_modules/@node-llama-cpp/linux-x64-cuda/**/*",
		"!node_modules/@node-llama-cpp/linux-x64-cuda-ext/**/*",
		"!node_modules/@node-llama-cpp/linux-x64-vulkan/**/*",
		"!node_modules/**/@mariozechner/clipboard-darwin-*/**/*",
		"!node_modules/**/@mariozechner/clipboard-win32-*/**/*",
		"!node_modules/**/@mariozechner/clipboard-linux-arm64-*/**/*",
		"!node_modules/**/@mariozechner/clipboard-linux-riscv64-*/**/*",
	],
};

const macNativeArchExcludes = {
	arm64: ["!node_modules/@node-llama-cpp/mac-x64/**/*"],
	x64: ["!node_modules/@node-llama-cpp/mac-arm64-*/**/*"],
};

export function applicationFilesFor(
	platform?: "mac" | "win" | "linux",
	arch?: "arm64" | "x64",
): string[] {
	return [
		"dist/**",
		"!dist/.runtime-build/**",
		"!dist/.windows-runtime/**",
		...productionExcludes,
		...(platform ? nativePackageExcludes[platform] : []),
		...(platform === "mac" && arch ? macNativeArchExcludes[arch] : []),
	];
}

export function extraResourcesFor(platform: NodeJS.Platform = process.platform) {
	return [
		{ from: "../../LICENSE", to: "LICENSE" },
		{ from: "../../BRAND-LICENSE", to: "BRAND-LICENSE" },
		{ from: attributionPath, to: "BRAND-ATTRIBUTION.txt" },
		{ from: "dist/character-seeds", to: "character-seeds" },
		...(platform === "win32"
			? [
					{ from: "dist/.windows-runtime/git", to: "git" },
					{
						from: "dist/.windows-runtime/manifest.json",
						to: "git-runtime-manifest.json",
					},
					{
						from: "dist/.windows-runtime/notices",
						to: "third-party/git-for-windows",
					},
				]
			: []),
	];
}

const phaseStarts = new Map<string, number>();
const appPaths = new Map<number, string>();
const zipJobs: Promise<{ file?: string; error?: unknown }>[] = [];
function phaseStart(name: string) {
	phaseStarts.set(name, performance.now());
	console.log(`package phase started: ${name}`);
}
function phaseEnd(name: string) {
	const started = phaseStarts.get(name);
	if (started !== undefined)
		console.log(
			`package phase finished: ${name} ${((performance.now() - started) / 1000).toFixed(2)}s`,
		);
}

// Windows ZIP/NSIS default to 7z levels 7/9. Level 5 keeps compression
// while avoiding the expensive final compression passes (see CI benchmark).
if (process.platform === "win32") process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= "5";

const config: Configuration = {
	beforePack: async () => {
		phaseStart("prepare Electron");
	},
	afterExtract: async () => {
		phaseEnd("prepare Electron");
		phaseStart("assemble application");
	},
	afterPack: async (context) => {
		phaseEnd("assemble application");
		appPaths.set(
			context.arch,
			context.electronPlatformName === "darwin"
				? resolve(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
				: context.appOutDir,
		);
	},
	artifactBuildStarted: async (event) => {
		phaseStart(event.file);
		// This event follows application signing, including when signing is off.
		// The ZIP runs alongside DMG/NSIS and never generates electron-updater data.
		if (event.targetPresentableName !== "DMG" && event.targetPresentableName !== "nsis") return;
		const appPath = event.arch === null ? undefined : appPaths.get(event.arch);
		if (!appPath) throw new Error("Missing finalized application for ZIP");
		const file = event.file.replace(/\.(dmg|exe)$/, ".zip");
		const prepared = await prepareZip({ platform: process.platform, appPath, file });
		// Attach rejection handling immediately; afterAllArtifactBuild propagates it.
		zipJobs.push(
			writeZip(prepared, file).then(
				(file: string) => ({ file }),
				(error: unknown) => ({ error }),
			),
		);
	},
	artifactBuildCompleted: async (event) => {
		if (event.file) phaseEnd(event.file);
	},
	afterAllArtifactBuild: async () => {
		const results = await Promise.all(zipJobs);
		return results.map((result) => {
			if ("error" in result) throw result.error;
			if (!result.file) throw new Error("ZIP generation did not return an artifact");
			return result.file;
		});
	},
	dmg: { writeUpdateInfo: false },
	nsis: { differentialPackage: false },
	appId: productConfig.appId,
	productName: productConfig.productName,
	executableName: productConfig.executableName,
	artifactName: productConfig.artifactName,
	directories: {
		app: ".",
		output: "release",
	},
	asar: true,
	// Native modules and dependent shared libraries cannot be loaded from ASAR.
	// node-llama-cpp chooses the target binding from the production dependency tree.
	asarUnpack: [
		"node_modules/@agentclientprotocol/codex-acp/**/*",
		"node_modules/node-llama-cpp/**/*",
		"node_modules/@node-llama-cpp/**/*",
		"node_modules/@napi-rs/canvas*/**/*",
		"node_modules/sqlite-vec*/**/*",
		"node_modules/@node-rs/jieba*/**/*",
	],
	files: applicationFilesFor(),
	// Desktop identity: package.json metadata's desktopName is overridden to
	// appId so Linux desktop integration matches the configured app id.
	extraMetadata: {
		desktopName: productConfig.appId,
	},
	extraResources: extraResourcesFor(),
	mac: {
		identity: null,
		icon: macIcon,
		electronLanguages: ["en", "zh_CN", "zh_TW"],
		files: applicationFilesFor(
			"mac",
			process.env.BEAR_PACKAGE_ARCH === "arm64" || process.env.BEAR_PACKAGE_ARCH === "x64"
				? process.env.BEAR_PACKAGE_ARCH
				: undefined,
		),
	},
	linux: {
		category: "Utility",
		maintainer: productConfig.brandLicense.creator,
		syncDesktopName: true,
		desktop: {
			entry: {
				Name: productConfig.productName,
			},
		},
		icon,
		electronLanguages: ["en-US", "zh-CN", "zh-TW"],
		files: applicationFilesFor("linux"),
	},
	win: {
		icon: windowsIcon,
		electronLanguages: ["en-US", "zh-CN", "zh-TW"],
		files: applicationFilesFor("win"),
	},
};

export default config;
