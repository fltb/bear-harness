// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCatalog } from "../src/providers/catalog.js";
import type { CredentialStore } from "../src/providers/credential-store.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("custom OpenAI-compatible provider configuration", () => {
	it("overrides a built-in provider endpoint without replacing its preset models", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-override-"));
		roots.push(root);
		const credentials = {
			list: vi.fn(async () => []),
			get: vi.fn(async () => undefined),
			getStatus: vi.fn(async () => "missing"),
			set: vi.fn(async () => "stored"),
		} as unknown as CredentialStore;
		const catalog = new ProviderCatalog(credentials, root);
		const before = (await catalog.listProviders()).find((provider) => provider.id === "openai");

		await catalog.overrideProviderBaseUrl({
			providerId: "openai",
			baseUrl: "https://relay.example.com/v1",
		});

		const after = (await catalog.listProviders()).find((provider) => provider.id === "openai");
		expect(after?.availableModels.map((model) => model.id)).toEqual(
			before?.availableModels.map((model) => model.id),
		);
		expect(JSON.parse(readFileSync(join(root, "models.json"), "utf8"))).toEqual({
			providers: { openai: { baseUrl: "https://relay.example.com/v1" } },
		});
		expect(credentials.set).not.toHaveBeenCalled();
	});

	it("persists endpoint/model metadata without writing the API key to models.json", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-custom-provider-"));
		roots.push(root);
		const credentials = {
			list: vi.fn(async () => []),
			get: vi.fn(async () => undefined),
			getStatus: vi.fn(async () => "missing"),
			set: vi.fn(async () => "stored"),
		} as unknown as CredentialStore;
		const catalog = new ProviderCatalog(credentials, root);

		await catalog.upsertCustomProvider({
			providerId: "local-openai",
			name: "Local OpenAI",
			baseUrl: "http://127.0.0.1:11434/v1",
			modelId: "vision-model",
			apiKey: "SECRET_SENTINEL",
			supportsImages: true,
		});

		const modelsPath = join(root, "models.json");
		expect(existsSync(modelsPath)).toBe(true);
		const raw = readFileSync(modelsPath, "utf8");
		expect(raw).toContain("http://127.0.0.1:11434/v1");
		expect(raw).toContain("vision-model");
		expect(JSON.parse(raw)).toMatchObject({
			providers: {
				"local-openai": { models: [{ input: ["text", "image"] }] },
			},
		});
		expect(raw).not.toContain("SECRET_SENTINEL");
		expect(credentials.set).toHaveBeenCalledWith(
			"local-openai",
			{ apiKey: "SECRET_SENTINEL" },
			{ sessionOnly: undefined },
		);
	});

	it("rejects non-http endpoint schemes", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-custom-provider-"));
		roots.push(root);
		const catalog = new ProviderCatalog({} as CredentialStore, root);
		await expect(
			catalog.upsertCustomProvider({
				providerId: "bad-provider",
				name: "Bad Provider",
				baseUrl: "file:///tmp/model",
				modelId: "model",
			}),
		).rejects.toMatchObject({ kind: "invalid_request" });
	});
});
