import { describe, expect, it } from "vitest";
import builderConfig, { extraResourcesFor } from "../electron-builder.config.js";

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
