// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCatalog } from "../src/providers/catalog.js";
import type { CredentialStore } from "../src/providers/credential-store.js";
import { ProviderListResponse } from "@bear-harness/protocol/schema";

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

	it("projects a custom provider endpoint without URL credentials or metadata secrets", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-projection-"));
		roots.push(root);
		const credentials = {
			list: vi.fn(async () => []),
			get: vi.fn(async () => undefined),
			getStatus: vi.fn(async () => "missing"),
			set: vi.fn(async () => "stored"),
		} as unknown as CredentialStore;
		const catalog = new ProviderCatalog(credentials, root);
		const apiKey = "API_KEY_SENTINEL";
		const username = "URL_USER_SENTINEL";
		const password = "URL_PASSWORD_SENTINEL";
		const querySecret = "QUERY_SECRET_SENTINEL";
		const fragmentSecret = "FRAGMENT_SECRET_SENTINEL";

		await catalog.upsertCustomProvider({
			providerId: "private-relay",
			name: "Private Relay",
			baseUrl: `https://${username}:${password}@relay.example.com/v1/?api_key=${querySecret}#${fragmentSecret}`,
			modelId: "private-model",
			apiKey,
		});

		const provider = (await catalog.listProviders()).find(
			(candidate) => candidate.id === "private-relay",
		);
		expect(provider?.baseUrl).toBe("https://relay.example.com/v1");
		expect(provider?.availableModels.map((model) => model.id)).toEqual(["private-model"]);
		const projection = JSON.stringify(provider);
		expect(projection).not.toContain(apiKey);
		expect(projection).not.toContain(username);
		expect(projection).not.toContain(password);
		expect(projection).not.toContain(`api_key=${querySecret}`);
		expect(projection).not.toContain(querySecret);
		expect(projection).not.toContain(fragmentSecret);
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

	it("passes advanced Pi model configuration through and rejects embedded credentials", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-model-import-"));
		roots.push(root);
		const catalog = new ProviderCatalog({} as CredentialStore, root);
		const config = {
			providers: {
				"advanced-relay": {
					name: "Advanced Relay",
					baseUrl: "https://relay.example/v1",
					api: "openai-completions",
					authHeader: true,
					models: [
						{
							id: "custom-reasoner",
							name: "Custom Reasoner",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 131072,
							maxTokens: 8192,
							samplingParams: { temperature: 0.3 },
						},
					],
				},
			},
		};

		await expect(catalog.importPiConfig(JSON.stringify(config))).resolves.toEqual([
			{
				providerId: "advanced-relay",
				modelId: "custom-reasoner",
				name: "Custom Reasoner",
				supportsImages: true,
			},
		]);
		expect(JSON.parse(readFileSync(join(root, "models.json"), "utf8"))).toEqual(config);

		const previous = readFileSync(join(root, "models.json"), "utf8");
		await expect(
			catalog.importPiConfig(
				JSON.stringify({
					providers: {
						bad: { apiKey: "SECRET_SENTINEL", models: [{ id: "bad" }] },
					},
				}),
			),
		).rejects.toMatchObject({ reason: "pi_model_config_must_not_contain_api_key" });
		expect(readFileSync(join(root, "models.json"), "utf8")).toBe(previous);
	});

	it("projects custom models whose standard costs omit optional tiers", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-cost-"));
		roots.push(root);
		const credentials = {
			list: vi.fn(async () => []),
			get: vi.fn(async () => undefined),
			getStatus: vi.fn(async () => "missing"),
			set: vi.fn(async () => "stored"),
		} as unknown as CredentialStore;
		const catalog = new ProviderCatalog(credentials, root);

		await catalog.importPiConfig(
			JSON.stringify({
				providers: {
					"standard-relay": {
						name: "Standard Relay",
						baseUrl: "https://relay.example/v1",
						api: "openai-completions",
						authHeader: true,
						models: [
							{
								id: "standard-model",
								name: "Standard Model",
								input: ["text"],
								cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
								contextWindow: 8192,
								maxTokens: 2048,
							},
						],
					},
				},
			}),
		);

		const response = ProviderListResponse.parse({ providers: await catalog.listProviders() });
		const provider = response.providers.find((candidate) => candidate.id === "standard-relay");
		expect(provider?.availableModels).toEqual([
			{
				id: "standard-model",
				name: "Standard Model",
				supportsImages: false,
				cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
			},
		]);
		expect(provider?.availableModels[0]?.cost).not.toHaveProperty("tiers");
	});
});
