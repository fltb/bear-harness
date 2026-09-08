const minutes = Number(process.env.BEAR_E2E_SOAK_MINUTES ?? "0");
if (!Number.isFinite(minutes) || minutes <= 0) {
	throw new Error("BEAR_E2E_SOAK_MINUTES must be a positive number");
}
const ci = process.env.CI === "1" || process.env.CI === "true";
if (ci && (process.env.BEAR_E2E_SOAK_MODE !== "release" || minutes < 120)) {
	throw new Error("CI soak requires release mode and at least 120 minutes");
}
