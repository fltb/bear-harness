// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ProviderListResponse } from "@bear-harness/protocol/schema";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCatalog } from "../src/providers/catalog.js";
import type { CredentialStore } from "../src/providers/credential-store.js";
import {
	DURABLE_FILE_TRANSACTION_VERSION,
	type DurableFileTransactionMarker,
	durableFileTransactionMarkerPath,
} from "../src/storage/durable-file-transaction.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const transactionId = "20000000-0000-4000-8000-000000000002";

function emptyCredentials(): CredentialStore {
	return {
		list: vi.fn(async () => []),
		get: vi.fn(async () => undefined),
		getStatus: vi.fn(async () => "missing"),
		set: vi.fn(async () => "stored"),
		remove: vi.fn(async () => undefined),
	} as unknown as CredentialStore;
}

function providerDocument(providerId: string, modelId: string): Record<string, unknown> {
	return {
		providers: {
			[providerId]: {
				name: providerId,
				baseUrl: "https://relay.example/v1",
				api: "openai-completions",
				authHeader: true,
				models: [{ id: modelId, name: modelId }],
			},
		},
	};
}

function transactionMarker(
	root: string,
	state: DurableFileTransactionMarker["state"],
): DurableFileTransactionMarker {
	const target = join(root, "models.json");
	const parent = dirname(target);
	const base = basename(target);
	return {
		version: DURABLE_FILE_TRANSACTION_VERSION,
		transactionId,
		target,
		staging: join(parent, `.${base}.staging-${transactionId}`),
		backup: join(parent, `.${base}.backup-${transactionId}`),
		state,
	};
}

function writeDocument(path: string, document: Record<string, unknown>): void {
	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

function persistMarker(root: string, marker: DurableFileTransactionMarker): void {
	writeFileSync(durableFileTransactionMarkerPath(root, marker.target), JSON.stringify(marker));
}

describe("custom OpenAI-compatible provider configuration", () => {
	it("projects every Pi authentication method instead of collapsing OAuth-capable providers", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-auth-methods-"));
		roots.push(root);
		const providers = await new ProviderCatalog(emptyCredentials(), root).listProviders();
		const anthropic = providers.find((provider) => provider.id === "anthropic");
		expect(anthropic?.authMethods).toEqual([
			{ type: "api_key", name: "Anthropic API key" },
			{
				type: "oauth",
				name: "Anthropic (Claude Pro/Max)",
				isSubscription: true,
			},
		]);
	});
	it("overrides a built-in provider endpoint without replacing its preset models", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-override-"));
		roots.push(root);
		const credentials = {
			list: vi.fn(async () => []),
			get: vi.fn(async () => undefined),
			getStatus: vi.fn(async () => "missing"),
			set: vi.fn(async () => "stored"),
			remove: vi.fn(async () => undefined),
		} as unknown as CredentialStore;
		const catalog = new ProviderCatalog(credentials, root);
		const before = (await catalog.listProviders()).find((provider) => provider.id === "openai");
		expect(before).toMatchObject({ source: "builtin", added: false });

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
		expect(after).toMatchObject({ source: "builtin", added: true });
		await catalog.removeProvider("openai");
		expect(credentials.remove).toHaveBeenCalledWith("openai");
		expect(JSON.parse(readFileSync(join(root, "models.json"), "utf8"))).toEqual({
			providers: {},
		});
		const removed = (await catalog.listProviders()).find((provider) => provider.id === "openai");
		expect(removed).toMatchObject({ source: "builtin", added: false });
		expect(credentials.set).not.toHaveBeenCalled();
	});

	it("rejects custom upserts that target a built-in provider identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-builtin-provider-"));
		roots.push(root);
		const credentials = {
			list: vi.fn(async () => []),
			get: vi.fn(async () => undefined),
			getStatus: vi.fn(async () => "missing"),
			set: vi.fn(async () => "stored"),
		} as unknown as CredentialStore;
		const catalog = new ProviderCatalog(credentials, root);

		await expect(
			catalog.upsertCustomProvider({
				providerId: "openai",
				name: "Forged OpenAI",
				baseUrl: "https://relay.example.com/v1",
				models: [{ id: "forged-model" }],
			}),
		).rejects.toMatchObject({
			kind: "invalid_request",
			reason: "custom_provider_must_be_custom: openai",
		});
		expect(existsSync(join(root, "models.json"))).toBe(false);
		expect(credentials.set).not.toHaveBeenCalled();
	});

	it("rejects built-in model fragments without changing existing provider configuration", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-builtin-import-"));
		roots.push(root);
		const modelsPath = join(root, "models.json");
		const previous = `${JSON.stringify(
			{ providers: { openai: { baseUrl: "https://relay.example.com/v1" } } },
			null,
			2,
		)}\n`;
		writeFileSync(modelsPath, previous, { mode: 0o600 });
		const catalog = new ProviderCatalog({} as CredentialStore, root);

		await expect(
			catalog.importPiConfig(
				JSON.stringify({
					providers: {
						openai: {
							baseUrl: "https://relay.example.com/v1",
							models: [{ id: "forged-model" }],
						},
					},
				}),
			),
		).rejects.toMatchObject({
			kind: "invalid_request",
			reason: "pi_model_config_builtin_catalog_forbidden",
		});
		expect(readFileSync(modelsPath, "utf8")).toBe(previous);
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
			models: [{ id: "vision-model", supportsImages: true }, { id: "text-model" }],
			apiKey: "SECRET_SENTINEL",
		});

		const modelsPath = join(root, "models.json");
		expect(existsSync(modelsPath)).toBe(true);
		const raw = readFileSync(modelsPath, "utf8");
		expect(raw).toContain("http://127.0.0.1:11434/v1");
		expect(raw).toContain("vision-model");
		const document = JSON.parse(raw) as {
			providers: Record<string, { models: Array<Record<string, unknown>> }>;
		};
		expect(document.providers["local-openai"].models.map((model) => model.id)).toEqual([
			"vision-model",
			"text-model",
		]);
		expect(document.providers["local-openai"].models[0]).toMatchObject({
			input: ["text", "image"],
		});
		expect(raw).not.toContain("SECRET_SENTINEL");
		expect(credentials.set).toHaveBeenCalledWith(
			"local-openai",
			{
				piCredential: { type: "api_key", key: "SECRET_SENTINEL" },
			},
			{ sessionOnly: false },
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
			models: [{ id: "private-model" }],
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
				models: [{ id: "model" }],
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

	it.each([
		{
			operation: "create",
			state: "old-target-moved" as const,
			oldDocument: undefined,
			newDocument: providerDocument("created-relay", "created-model"),
		},
		{
			operation: "update from stale staging",
			state: "staged" as const,
			oldDocument: providerDocument("updated-relay", "old-model"),
			newDocument: providerDocument("updated-relay", "new-model"),
		},
		{
			operation: "remove",
			state: "old-target-moved" as const,
			oldDocument: providerDocument("removed-relay", "removed-model"),
			newDocument: { providers: {} },
		},
		{
			operation: "import after activation",
			state: "activated" as const,
			oldDocument: providerDocument("original-relay", "original-model"),
			newDocument: providerDocument("imported-relay", "imported-model"),
		},
	])("recovers a durable $operation crash to a complete new document", async (scenario) => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-recovery-"));
		roots.push(root);
		const marker = transactionMarker(root, scenario.state);
		if (scenario.state === "staged") {
			if (scenario.oldDocument) writeDocument(marker.target, scenario.oldDocument);
			writeDocument(marker.staging, scenario.newDocument);
		} else if (scenario.state === "old-target-moved") {
			if (scenario.oldDocument) writeDocument(marker.backup, scenario.oldDocument);
			writeDocument(marker.staging, scenario.newDocument);
		} else {
			writeDocument(marker.target, scenario.newDocument);
			if (scenario.oldDocument) writeDocument(marker.backup, scenario.oldDocument);
		}
		persistMarker(root, marker);

		await new ProviderCatalog(emptyCredentials(), root).listProviders();

		expect(JSON.parse(readFileSync(marker.target, "utf8"))).toEqual(scenario.newDocument);
		expect(existsSync(marker.staging)).toBe(false);
		expect(existsSync(marker.backup)).toBe(false);
		expect(existsSync(durableFileTransactionMarkerPath(root, marker.target))).toBe(false);
	});

	it("surfaces ambiguous recovery without overwriting any complete copy", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-ambiguous-"));
		roots.push(root);
		const marker = transactionMarker(root, "old-target-moved");
		const target = providerDocument("target-relay", "target-model");
		const staging = providerDocument("staging-relay", "staging-model");
		const backup = providerDocument("backup-relay", "backup-model");
		writeDocument(marker.target, target);
		writeDocument(marker.staging, staging);
		writeDocument(marker.backup, backup);
		persistMarker(root, marker);

		await expect(
			new ProviderCatalog(emptyCredentials(), root).listProviders(),
		).rejects.toMatchObject({ kind: "conflict", reason: "recovery_required" });
		expect(JSON.parse(readFileSync(marker.target, "utf8"))).toEqual(target);
		expect(JSON.parse(readFileSync(marker.staging, "utf8"))).toEqual(staging);
		expect(JSON.parse(readFileSync(marker.backup, "utf8"))).toEqual(backup);
		expect(existsSync(durableFileTransactionMarkerPath(root, marker.target))).toBe(true);
	});

	it("surfaces a malformed recovery marker without overwriting the valid target", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-malformed-marker-"));
		roots.push(root);
		const modelsPath = join(root, "models.json");
		const previous = providerDocument("stable-relay", "stable-model");
		writeDocument(modelsPath, previous);
		const markerPath = durableFileTransactionMarkerPath(root, modelsPath);
		writeFileSync(markerPath, JSON.stringify({ version: 99, target: modelsPath }));

		await expect(
			new ProviderCatalog(emptyCredentials(), root).listProviders(),
		).rejects.toMatchObject({ kind: "conflict", reason: "recovery_required" });
		expect(JSON.parse(readFileSync(modelsPath, "utf8"))).toEqual(previous);
		expect(existsSync(markerPath)).toBe(true);
	});

	it("rejects malformed staged provider models and preserves the complete old document", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-validation-"));
		roots.push(root);
		const modelsPath = join(root, "models.json");
		const previous = providerDocument("stable-relay", "stable-model");

		writeDocument(modelsPath, previous);
		const catalog = new ProviderCatalog(emptyCredentials(), root);

		await expect(
			catalog.importPiConfig(
				JSON.stringify({
					providers: {
						"invalid-relay": {
							baseUrl: "https://relay.example/v1",
							models: [{ id: "duplicate" }, { id: "duplicate" }],
						},
					},
				}),
			),
		).rejects.toMatchObject({ reason: "pi_model_config_rejected" });
		expect(JSON.parse(readFileSync(modelsPath, "utf8"))).toEqual(previous);
		expect(existsSync(durableFileTransactionMarkerPath(root, modelsPath))).toBe(false);
	});
	it("rolls an activated import back when post-activation provider validation fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-post-validation-"));
		roots.push(root);
		const modelsPath = join(root, "models.json");
		const previous = providerDocument("stable-relay", "stable-model");
		writeDocument(modelsPath, previous);
		const originalCreate = ModelRuntime.create.bind(ModelRuntime);
		let validationCalls = 0;
		const create = vi
			.spyOn(ModelRuntime, "create")
			.mockImplementation(async (...args: Parameters<typeof ModelRuntime.create>) => {
				validationCalls += 1;
				if (validationCalls === 3) throw new Error("post-activation validation failure");
				return originalCreate(...args);
			});

		try {
			await expect(
				new ProviderCatalog(emptyCredentials(), root).importPiConfig(
					JSON.stringify(providerDocument("replacement-relay", "replacement-model")),
				),
			).rejects.toMatchObject({ reason: "pi_model_config_rejected" });
		} finally {
			create.mockRestore();
		}
		expect(validationCalls).toBe(3);
		expect(JSON.parse(readFileSync(modelsPath, "utf8"))).toEqual(previous);
		expect(existsSync(durableFileTransactionMarkerPath(root, modelsPath))).toBe(false);
	});

	it.each([
		{ accessToken: "ACCESS_TOKEN_SENTINEL" },
		{ refresh_token: "REFRESH_TOKEN_SENTINEL" },
		{ headers: { Authorization: "Bearer AUTH_SENTINEL" } },
		{ headers: { "X-API-Key": "HEADER_KEY_SENTINEL" } },
	])("rejects imported secret-bearing metadata without touching models.json", async (secret) => {
		const root = mkdtempSync(join(tmpdir(), "bear-provider-secret-"));
		roots.push(root);
		const modelsPath = join(root, "models.json");
		const previous = providerDocument("stable-relay", "stable-model");
		writeDocument(modelsPath, previous);
		const catalog = new ProviderCatalog(emptyCredentials(), root);

		await expect(
			catalog.importPiConfig(
				JSON.stringify({
					providers: {
						"secret-relay": {
							baseUrl: "https://relay.example/v1",
							models: [{ id: "secret-model", ...secret }],
						},
					},
				}),
			),
		).rejects.toMatchObject({ reason: "pi_model_config_must_not_contain_api_key" });
		expect(JSON.parse(readFileSync(modelsPath, "utf8"))).toEqual(previous);
	});
});
