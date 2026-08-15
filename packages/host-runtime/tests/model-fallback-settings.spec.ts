// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import { type CredentialVault, createHostRuntime } from "../src/index.js";

const roots: string[] = [];
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const vault: CredentialVault = {
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("model fallback settings", () => {
	it("persists text and multimodal fallback routes independently", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-model-fallback-"));
		roots.push(dataDir);
		const runtime = createHostRuntime({
			dataDir,
			characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		const textFallback = { providerId: "provider-a", modelId: "text-model" };
		const multimodalFallback = { providerId: "provider-b", modelId: "vision-model" };

		const saved = await runtime.dispatch("settings.set:v1", {
			settings: { textFallback, multimodalFallback },
		});
		expect(saved).toMatchObject({ ok: true });
		const loaded = await runtime.dispatch("settings.get:v1", {});
		expect(loaded).toMatchObject({
			ok: true,
			data: { settings: { textFallback, multimodalFallback } },
		});
		await runtime.dispatch("settings.set:v1", {
			settings: { textFallback: null, multimodalFallback: null },
		});
		const disabled = await runtime.dispatch("settings.get:v1", {});
		expect(disabled).toMatchObject({
			ok: true,
			data: { settings: { relationshipMemoryEnabled: false } },
		});
		expect((disabled as { data?: { settings?: object } }).data?.settings).not.toHaveProperty(
			"textFallback",
		);
		expect((disabled as { data?: { settings?: object } }).data?.settings).not.toHaveProperty(
			"multimodalFallback",
		);
		await runtime.close();
	});
});
