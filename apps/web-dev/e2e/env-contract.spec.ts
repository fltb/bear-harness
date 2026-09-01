import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "playwright/test";

test("documents every environment variable required to provision a custom provider", () => {
	const example = readFileSync(resolve(import.meta.dirname, "../../../.env.example"), "utf8");
	for (const name of [
		"BEAR_CUSTOM_PROVIDER_ID",
		"BEAR_CUSTOM_PROVIDER_NAME",
		"BEAR_CUSTOM_BASE_URL",
		"BEAR_CUSTOM_MODEL_ID",
		"BEAR_CUSTOM_API_KEY",
	]) {
		expect(example).toContain(`${name}=`);
	}
});

test("documents endpoint overrides that retain a provider's preset models", () => {
	const example = readFileSync(resolve(import.meta.dirname, "../../../.env.example"), "utf8");
	for (const name of ["BEAR_PROVIDER_OVERRIDE_ID", "BEAR_PROVIDER_OVERRIDE_BASE_URL"]) {
		expect(example).toContain(`${name}=`);
	}
});

test("documents Provider credentials independently from endpoint overrides", () => {
	const example = readFileSync(resolve(import.meta.dirname, "../../../.env.example"), "utf8");
	for (const name of ["BEAR_PROVIDER_CREDENTIAL_ID", "BEAR_PROVIDER_API_KEY"]) {
		expect(example).toContain(`${name}=`);
	}
});

test("provisions the custom provider from WebDev environment variables", async ({ page }) => {
	await page.goto("/");
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const response = await page.request.post("/rpc/provider.list", {
		headers: { "x-bear-web-dev-token": bootstrap.token },
		data: {},
	});
	const envelope = await response.json();
	expect(envelope.ok).toBe(true);
	expect(envelope.data.providers).toContainEqual(
		expect.objectContaining({
			id: "e2e-rule",
			name: "E2E Rule Provider",
			availableModels: [expect.objectContaining({ id: "rule-model" })],
		}),
	);
});
