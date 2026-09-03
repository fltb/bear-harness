const required = ["BEAR_E2E_PROVIDER_ID", "BEAR_E2E_MODEL_ID", "BEAR_E2E_SECONDARY_MODEL_ID"];
if (process.env.BEAR_E2E_LIVE_MODEL !== "1") {
	throw new Error("BEAR_E2E_LIVE_MODEL=1 is required by the release gate");
}
for (const name of required) {
	if (!process.env[name]) throw new Error(`${name} is required by the release gate`);
}
if (!process.env.BEAR_E2E_API_KEY && process.env.BEAR_E2E_USE_PI_CONFIG !== "1") {
	throw new Error("BEAR_E2E_API_KEY or BEAR_E2E_USE_PI_CONFIG=1 is required by the release gate");
}
console.log("Live-model release prerequisites present");
