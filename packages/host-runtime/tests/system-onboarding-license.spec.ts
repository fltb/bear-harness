// @vitest-environment node

import { describe, expect, it } from "vitest";
import { assertSystemOnboardingLicenses } from "../src/system-onboarding-license.js";

describe("system onboarding license policy", () => {
	it.each(["darwin", "linux"] as const)(
		"requires only the Bear GPL acknowledgement on %s",
		(platform) => {
			expect(() =>
				assertSystemOnboardingLicenses(platform, { bear: "GPL-3.0-only" }),
			).not.toThrow();
		},
	);

	it("requires the bundled Git for Windows acknowledgement on Windows", () => {
		let rejection: unknown;
		try {
			assertSystemOnboardingLicenses("win32", { bear: "GPL-3.0-only" });
		} catch (error) {
			rejection = error;
		}
		expect(rejection).toEqual({
			kind: "invalid_request",
			reason: "windows_git_license_acknowledgement_required",
		});
		expect(() =>
			assertSystemOnboardingLicenses("win32", {
				bear: "GPL-3.0-only",
				gitForWindows: "GPL-2.0-only",
			}),
		).not.toThrow();
	});
});
