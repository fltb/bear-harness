// @vitest-environment node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateProductConfig } from "../../scripts/validate-product-config.mjs";
import { FORK_PRODUCT, OFFICIAL_PRODUCT } from "../fixtures";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
const attributionPath = join(desktopRoot, "dist/brand/BRAND-ATTRIBUTION.txt");
const packageJsonPath = join(desktopRoot, "package.json");

function runValidator(...args: string[]) {
	return spawnSync(process.execPath, ["scripts/validate-product-config.mjs", ...args], {
		cwd: desktopRoot,
		encoding: "utf8",
	});
}
describe("validate-product-config", () => {
	it("accepts the official config", () => {
		expect(validateProductConfig(OFFICIAL_PRODUCT)).toEqual([]);
	});

	it("accepts a complete fork config", () => {
		expect(validateProductConfig(FORK_PRODUCT)).toEqual([]);
	});

	it.each([
		["bad appId", { ...OFFICIAL_PRODUCT, appId: "bad" }, "appId"],
		[
			"missing artifact macro",
			{ ...OFFICIAL_PRODUCT, artifactName: "\${productName}-\${version}-\${os}.\${ext}" },
			"artifactName",
		],
		[
			"wrong CC SPDX",
			{ ...OFFICIAL_PRODUCT, brandLicense: { ...OFFICIAL_PRODUCT.brandLicense, spdx: "MIT" } },
			"brandLicense.spdx",
		],
		[
			"modified without notice",
			{ ...FORK_PRODUCT, brandLicense: { ...FORK_PRODUCT.brandLicense, modificationNotice: "" } },
			"brandLicense.modificationNotice",
		],
		["nonexistent icon", { ...FORK_PRODUCT, icon: "assets/does-not-exist.png" }, "icon"],
	])("rejects %s with the fixed prefix", (_label, config, field) => {
		expect(validateProductConfig(config).map((error) => error.field)).toContain(field);
	});

	it("rejects an identity change that keeps the official appId", () => {
		const config = { ...OFFICIAL_PRODUCT, productName: "Renamed" };
		expect(validateProductConfig(config).map((error) => error.field)).toContain("appId");
	});

	it("rejects a non-1024x1024 PNG icon", () => {
		const repoRoot = resolve(desktopRoot, "../..");
		const relative = `apps/desktop/tests/.tmp-small-icon-${Date.now()}.png`;
		const pngPath = join(repoRoot, relative);
		// Minimal PNG header claiming 8x8 (wrong size).
		writeFileSync(
			pngPath,
			Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
				0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x08, 0x06, 0x00, 0x00, 0x00,
			]),
		);
		try {
			const config = { ...FORK_PRODUCT, icon: relative };
			expect(validateProductConfig(config).map((error) => error.field)).toContain("icon");
		} finally {
			rmSync(pngPath, { force: true });
		}
	});

	it("requires product validation before each packaging command", () => {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			scripts: Record<string, string>;
		};
		for (const name of ["package:mac:arm64", "package:mac:x64", "package:win", "package:linux"]) {
			const command = packageJson.scripts[name];
			const validation = command.indexOf("node scripts/validate-product-config.mjs");
			const build = command.indexOf("npm run build");
			expect(validation, `${name} must validate product config`).toBeGreaterThanOrEqual(0);
			expect(validation, `${name} must validate before build`).toBeLessThan(build);
		}
	});

	it("runs attribution generation before compiling main in build staging", () => {
		const buildSource = readFileSync(join(desktopRoot, "scripts/build.mjs"), "utf8");
		const compileMarker = 'run("npx", ["--no-install", "tsc", "-p", "tsconfig.main.json"])';
		const validation = buildSource.indexOf('run("node", ["scripts/validate-product-config.mjs"])');
		const compile = buildSource.indexOf(compileMarker);
		expect(validation).toBeGreaterThan(buildSource.indexOf('rmSync(resolve(desktop, "dist")'));
		expect(validation).toBeLessThan(compile);
	});

	it("declares all native capability modules for unpacking", () => {
		const builderSource = readFileSync(join(desktopRoot, "electron-builder.config.ts"), "utf8");
		for (const pattern of [
			"node_modules/node-llama-cpp/**/*",
			"node_modules/@node-llama-cpp/**/*",
			"node_modules/sqlite-vec*/**/*",
			"node_modules/@node-rs/jieba*/**/*",
		]) {
			expect(builderSource).toContain(pattern);
		}
	});

	it("filters foreign llama bindings and the optional CUDA extension from release targets", () => {
		const builderSource = readFileSync(join(desktopRoot, "electron-builder.config.ts"), "utf8");
		for (const pattern of ["linux-x64-cuda-ext", "win-x64-cuda-ext", "linux-arm64", "win-arm64"]) {
			expect(builderSource).toContain(pattern);
		}
	});

	it("stages deterministic attribution and preserves --no-write validation", async () => {
		const previous = existsSync(attributionPath) ? readFileSync(attributionPath) : null;
		try {
			rmSync(attributionPath, { force: true });
			const noWrite = runValidator("--no-write");
			expect(noWrite.status).toBe(0);
			expect(existsSync(attributionPath)).toBe(false);

			const firstWrite = runValidator();
			expect(firstWrite.status).toBe(0);
			expect(existsSync(attributionPath)).toBe(true);
			const first = readFileSync(attributionPath, "utf8");
			// Dynamic import: the builder config runs a filesystem existence check at
			// module load, so it must be loaded after staging, not at spec import time.
			const builder = (await import("../../electron-builder.config.ts")).default as {
				extraResources?: Array<{ from: string; to: string }>;
			};
			expect(builder.extraResources).toContainEqual({
				from: attributionPath,
				to: "BRAND-ATTRIBUTION.txt",
			});
			expect(builder.extraResources).toContainEqual({ from: "resources/runtime", to: "runtime" });
			expect(builder.extraResources).toContainEqual({
				from: "ThirdPartyNotices",
				to: "ThirdPartyNotices",
			});

			const secondWrite = runValidator();
			expect(secondWrite.status).toBe(0);
			expect(readFileSync(attributionPath, "utf8")).toBe(first);
		} finally {
			if (previous) writeFileSync(attributionPath, previous);
			else rmSync(attributionPath, { force: true });
		}
	});
});
