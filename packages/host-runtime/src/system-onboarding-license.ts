export interface SystemOnboardingLicenseAcknowledgements {
	bear: "GPL-3.0-only";
	gitForWindows?: "GPL-2.0-only";
}

/** Enforce platform-owned license disclosures before first-run setup is committed. */
export function assertSystemOnboardingLicenses(
	platform: NodeJS.Platform,
	acknowledgements: SystemOnboardingLicenseAcknowledgements,
): void {
	if (platform === "win32" && acknowledgements.gitForWindows !== "GPL-2.0-only") {
		throw {
			kind: "invalid_request",
			reason: "windows_git_license_acknowledgement_required",
		};
	}
}
