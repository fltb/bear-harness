/**
 * electron-builder configuration. The single source of release identity is
 * product.config.ts; this file only maps it onto electron-builder options so
 * the UI title and the installation identity can never drift apart.
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
import type { Configuration } from "electron-builder";
import { productConfig } from "./product.config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
// Icon paths in product.config.ts are repo-root-relative.
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
	files: ["dist/**"],
	// Desktop identity: package.json metadata's desktopName is overridden to
	// appId so Linux desktop integration matches the configured app id.
	extraMetadata: {
		desktopName: productConfig.appId,
	},
	extraResources: [
		{ from: "../../LICENSE", to: "LICENSE" },
		{ from: "../../BRAND-LICENSE", to: "BRAND-LICENSE" },
		{ from: "dist/brand/BRAND-ATTRIBUTION.txt", to: "BRAND-ATTRIBUTION.txt" },
	],
	mac: {
		identity: null,
		...(icon ? { icon } : {}),
	},
	linux: {
		category: "Utility",
		syncDesktopName: true,
		desktop: {
			entry: {
				Name: productConfig.productName,
			},
		},
		...(icon ? { icon } : {}),
	},
	win: {
		...(icon ? { icon } : {}),
	},
};

export default config;
