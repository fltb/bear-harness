import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import builderConfig, { extraResourcesFor } from "../electron-builder.config.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function manifest(path: string): {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
} {
	return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

describe("electron-builder product identity", () => {
	it("projects the exact Bear Harness identity into package metadata", () => {
		expect(builderConfig).toMatchObject({
			appId: "io.github.fltb.bear-harness",
			productName: "Bear Harness",
			executableName: "bear-harness",
			artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
			extraMetadata: {
				desktopName: "io.github.fltb.bear-harness",
			},
			linux: {
				maintainer: "fltb",
				syncDesktopName: true,
				desktop: {
					entry: {
						Name: "Bear Harness",
					},
				},
			},
		});
	});
});

describe("electron-builder Windows runtime resources", () => {
	it("includes Git, its checked manifest, and notices only on Windows", () => {
		expect(extraResourcesFor("win32").map((resource) => resource.to)).toEqual(
			expect.arrayContaining(["git", "git-runtime-manifest.json", "third-party/git-for-windows"]),
		);
		for (const platform of ["darwin", "linux"] satisfies NodeJS.Platform[]) {
			const destinations = extraResourcesFor(platform).map((resource) => resource.to);
			expect(destinations).not.toContain("git");
			expect(destinations).not.toContain("git-runtime-manifest.json");
			expect(destinations).not.toContain("third-party/git-for-windows");
		}
		expect(builderConfig.files).toContain("!dist/.windows-runtime/**");
	});
});

describe("electron-builder production boundary", () => {
	it("ships only the product locales and excludes disabled or build-only payloads", () => {
		expect(builderConfig.electronLanguages).toEqual(["en", "zh_CN", "zh_TW"]);
		const files = [
			...((builderConfig.files ?? []) as string[]),
			...(((builderConfig.mac as { files?: string[] } | undefined)?.files ?? []) as string[]),
		];
		for (const required of [
			"dist/**",
			"!node_modules/node-llama-cpp/llama/gitRelease.bundle",
			"!node_modules/pdfjs-dist/build/**/*",
			"!node_modules/pdfjs-dist/web/**/*",
			"!node_modules/@openai/codex*/**/*",
			"!node_modules/@agentclientprotocol/codex-acp/**/*",
			"!node_modules/@tencentdb-agent-memory/**/*",
			"!node_modules/tesseract.js/**/*",
			"!node_modules/tesseract.js-core/**/*",
			"!**/*.map",
			"!**/*.d.ts",
			"!**/*.tsbuildinfo",
		]) {
			expect(files).toContain(required);
		}
	});

	it("keeps disabled executors and sparse-vector data out of production dependencies", () => {
		const host = manifest("packages/host-runtime/package.json");
		const tdai = manifest("packages/tdai-core/package.json");
		expect(host.dependencies).not.toHaveProperty("@agentclientprotocol/codex-acp");
		expect(host.devDependencies).toHaveProperty("@agentclientprotocol/codex-acp");
		expect(tdai.dependencies).not.toHaveProperty("@tencentdb-agent-memory/tcvdb-text");
		expect(tdai.devDependencies).toHaveProperty("@tencentdb-agent-memory/tcvdb-text");
	});

	it("does not classify renderer-only packages as desktop runtime dependencies", () => {
		const desktop = manifest("apps/desktop/package.json");
		for (const name of [
			"@bear-harness/companion-client",
			"@bear-harness/companion-ui",
			"@bear-harness/i18n",
		]) {
			expect(desktop.dependencies).not.toHaveProperty(name);
			expect(desktop.devDependencies).toHaveProperty(name);
		}
	});

	it("packages the native llama runtime once from the production dependency tree", () => {
		const desktop = manifest("apps/desktop/package.json") as {
			scripts?: Record<string, string>;
		};
		for (const command of Object.values(desktop.scripts ?? {})) {
			expect(command).not.toContain("stage-native-bindings.mjs");
		}
		expect(builderConfig.asarUnpack).toEqual(
			expect.arrayContaining([
				"node_modules/node-llama-cpp/**/*",
				"node_modules/@node-llama-cpp/**/*",
			]),
		);
		const files = (builderConfig.files ?? []) as string[];
		expect(files).toContain("!dist/main/node_modules/**/*");
	});

	it("verifies production boundaries and native bindings after every package build", () => {
		const desktop = manifest("apps/desktop/package.json") as {
			scripts?: Record<string, string>;
		};
		for (const [name, target] of [
			["package:mac:arm64", "mac arm64"],
			["package:mac:x64", "mac x64"],
			["package:win", "win x64"],
			["package:linux", "linux x64"],
		] as const) {
			const command = desktop.scripts?.[name];
			expect(command).toContain(`verify-package-boundary.mjs ${target}`);
			expect(command).toContain(`verify-native-bindings.mjs ${target}`);
		}
	});
});
