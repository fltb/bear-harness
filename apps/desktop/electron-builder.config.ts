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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import type { Configuration } from "electron-builder";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
// Icon paths in the shared product config are repo-root-relative.
const icon = productConfig.icon ? resolve(repoRoot, productConfig.icon) : undefined;

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
	asarUnpack: ["node_modules/@napi-rs/canvas*/**/*"],
	files: ["dist/**", "!dist/.runtime-build/**"],
	// Desktop identity: package.json metadata's desktopName is overridden to
	// appId so Linux desktop integration matches the configured app id.
	extraMetadata: {
		desktopName: productConfig.appId,
	},
	extraResources: [
		{ from: "../../LICENSE", to: "LICENSE" },
		{ from: "../../BRAND-LICENSE", to: "BRAND-LICENSE" },
		{ from: "dist/brand/BRAND-ATTRIBUTION.txt", to: "BRAND-ATTRIBUTION.txt" },
		{ from: "../../config", to: "config" },
	],
	mac: {
		identity: null,
		icon,
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
	},
	win: {
		icon,
	},
};

export default config;
