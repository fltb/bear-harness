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

// Native bindings are staged beneath dist/main/node_modules immediately before
// packaging. Every artifact therefore contains exactly the binding built for
// its runner target, never a foreign platform or architecture.
const nativeBindingExcludes = {
	mac: [
		"!dist/main/node_modules/@node-llama-cpp/linux-*/**/*",
		"!dist/main/node_modules/@node-llama-cpp/win-*/**/*",
	],
	win: [
		"!dist/main/node_modules/@node-llama-cpp/linux-*/**/*",
		"!dist/main/node_modules/@node-llama-cpp/mac-*/**/*",
		"!dist/main/node_modules/@node-llama-cpp/win-arm64/**/*",
		"!dist/main/node_modules/@node-llama-cpp/win-x64-cuda-ext/**/*",
	],
	linux: [
		"!dist/main/node_modules/@node-llama-cpp/mac-*/**/*",
		"!dist/main/node_modules/@node-llama-cpp/win-*/**/*",
		"!dist/main/node_modules/@node-llama-cpp/linux-arm64/**/*",
		"!dist/main/node_modules/@node-llama-cpp/linux-armv7l/**/*",
		"!dist/main/node_modules/@node-llama-cpp/linux-x64-cuda-ext/**/*",
	],
};

const config: Configuration = {
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
	// node-llama-cpp's package chooses the staged target binding at runtime.
	asarUnpack: [
		"dist/main/node_modules/node-llama-cpp/**/*",
		"dist/main/node_modules/@node-llama-cpp/**/*",
		"node_modules/@napi-rs/canvas*/**/*",
		"node_modules/sqlite-vec*/**/*",
		"node_modules/@node-rs/jieba*/**/*",
	],
	files: ["dist/**", "!dist/.runtime-build/**"],
	// Desktop identity: package.json metadata's desktopName is overridden to
	// appId so Linux desktop integration matches the configured app id.
	extraMetadata: {
		desktopName: productConfig.appId,
	},
	extraResources: [
		{ from: "../../LICENSE", to: "LICENSE" },
		{ from: "../../BRAND-LICENSE", to: "BRAND-LICENSE" },
		{ from: attributionPath, to: "BRAND-ATTRIBUTION.txt" },
		{ from: "dist/character-seeds", to: "character-seeds" },
		{ from: "resources/runtime", to: "runtime" },
		{ from: "ThirdPartyNotices", to: "ThirdPartyNotices" },
	],
	mac: {
		identity: null,
		icon,
		files: nativeBindingExcludes.mac,
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
		files: nativeBindingExcludes.linux,
	},
	win: {
		icon,
		files: nativeBindingExcludes.win,
	},
};

export default config;
