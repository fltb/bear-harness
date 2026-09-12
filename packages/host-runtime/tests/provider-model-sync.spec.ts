// Model pool reads reproject added Provider catalogs into configured_models.
// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HostCompositionContext, wireHostHandlers } from "../src/composition.js";
import { Dispatcher } from "../src/dispatcher.js";
import { type CredentialVault, createHostRuntime, type HostRuntime } from "../src/index.js";
import {
	type DurableFileTransactionMarker,
	durableFileTransactionMarkerPath,
} from "../src/storage/durable-file-transaction.js";

const roots: string[] = [];
const runtimes: HostRuntime[] = [];
const characterRoot = fileURLToPath(new URL("./fixtures/characters", import.meta.url));
const silentLogger = { debug: () => undefined, warn: () => undefined };
const vault: CredentialVault = {
	securityLevel: "session",
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

function makeRuntimeAt(dataDir: string): HostRuntime {
	const runtime = createHostRuntime({
		dataDir,
		characterSeedRoot: characterRoot,
		productConfig,
		credentialVault: vault,
		logger: silentLogger,
	});
	runtimes.push(runtime);
	return runtime;
}

function makeRuntime(): HostRuntime {
	const dataDir = mkdtempSync(join(tmpdir(), "bear-provider-sync-"));
	roots.push(dataDir);
	return makeRuntimeAt(dataDir);
}

async function data(runtime: HostRuntime, channel: string, params: unknown): Promise<unknown> {
	const response = await runtime.dispatch(channel, params);
	if (!response.ok) throw new Error(response.error.reason);
	return response.data;
}

function removeRuntime(runtime: HostRuntime): void {
	const index = runtimes.indexOf(runtime);
	if (index >= 0) runtimes.splice(index, 1);
}

function restartMarker(dataDir: string): DurableFileTransactionMarker {
	const target = join(dataDir, "system", "providers", "models.json");
	const parent = dirname(target);
	const base = basename(target);
	const transactionId = "30000000-0000-4000-8000-000000000003";
	return {
		schemaVersion: 1,
		transactionId,
		target,
		staging: join(parent, `.${base}.staging-${transactionId}`),
		backup: join(parent, `.${base}.backup-${transactionId}`),
		state: "staged",
	};
}

describe("provider catalog model synchronization", () => {
	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.close();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("makes every custom provider catalog model available and remains idempotent", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const input = {
			providerId: "sync-relay",
			name: "Sync Relay",
			baseUrl: "http://127.0.0.1:11434/v1",
			models: [
				{ id: "vision", name: "Vision", supportsImages: true },
				{ id: "text", name: "Text", supportsImages: false },
			],
		};

		await data(runtime, "provider.customUpsert", input);
		await data(runtime, "provider.customUpsert", input);
		const pool = (await data(runtime, "model.pool.get", {})) as {
			models: Array<{
				providerId: string;
				modelId: string;
				label: string;
				supportsImages: boolean;
				enabled: boolean;
				readiness: string;
			}>;
		};
		const relayModels = pool.models.filter((model) => model.providerId === "sync-relay");
		expect(relayModels).toHaveLength(2);
		expect(relayModels).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ modelId: "vision", label: "Vision", supportsImages: true }),
				expect.objectContaining({ modelId: "text", label: "Text", supportsImages: false }),
			]),
		);

		await data(runtime, "provider.setApiKey", {
			providerId: "sync-relay",
			apiKey: "session-key",
		});
		const afterKey = (await data(runtime, "model.pool.get", {})) as typeof pool;
		expect(afterKey.models.filter((model) => model.providerId === "sync-relay")).toHaveLength(2);
		const listed = (await data(runtime, "provider.list", {})) as {
			providers: Array<{ id: string; source: string; added: boolean }>;
		};
		expect(listed.providers.find((provider) => provider.id === "sync-relay")).toMatchObject({
			source: "custom",
			added: true,
		});
		await data(runtime, "model.defaults.setReply", {
			reply: { providerId: "sync-relay", modelId: "text" },
		});
		await data(runtime, "model.defaults.setVision", {
			mode: "manual",
			route: { providerId: "sync-relay", modelId: "vision" },
		});
		await data(runtime, "provider.remove", { providerId: "sync-relay" });
		const afterRemove = (await data(runtime, "model.pool.get", {})) as typeof pool;
		const removedProviderModels = afterRemove.models.filter(
			(model) => model.providerId === "sync-relay",
		);
		expect(removedProviderModels).toHaveLength(2);
		expect(removedProviderModels).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ modelId: "vision", enabled: false, readiness: "disabled" }),
				expect.objectContaining({ modelId: "text", enabled: false, readiness: "disabled" }),
			]),
		);
		const defaults = (await data(runtime, "model.defaults.get", {})) as {
			reply?: { providerId: string; modelId: string };
			vision: { mode: string };
		};
		expect(defaults.reply).toBeUndefined();
		expect(defaults.vision).toEqual({ mode: "auto" });
		const afterProviderRemove = (await data(runtime, "provider.list", {})) as {
			providers: Array<{ id: string }>;
		};
		expect(afterProviderRemove.providers.some((provider) => provider.id === "sync-relay")).toBe(
			false,
		);
	}, 15_000);

	it("restarts through a stale models transaction and exposes only the complete new catalog", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-provider-restart-"));
		roots.push(dataDir);
		const first = makeRuntimeAt(dataDir);
		await first.start();
		await data(first, "provider.customUpsert", {
			providerId: "restart-relay",
			name: "Restart Relay",
			baseUrl: "https://relay.example/v1",
			models: [{ id: "old-model" }],
		});
		await first.close();
		removeRuntime(first);

		const marker = restartMarker(dataDir);
		const nextDocument = {
			providers: {
				"restart-relay": {
					name: "Restart Relay",
					baseUrl: "https://relay.example/v1",
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "new-model", name: "New Model" }],
				},
			},
		};
		writeFileSync(marker.staging, `${JSON.stringify(nextDocument, null, 2)}\n`, { mode: 0o600 });
		writeFileSync(
			durableFileTransactionMarkerPath(dirname(marker.target), marker.target),
			JSON.stringify(marker),
		);

		const restarted = makeRuntimeAt(dataDir);
		await restarted.start();
		const listed = (await data(restarted, "provider.list", {})) as {
			providers: Array<{ id: string; availableModels: Array<{ id: string }> }>;
		};

		expect(
			listed.providers.find((provider) => provider.id === "restart-relay")?.availableModels,
		).toMatchObject([{ id: "new-model" }]);
		expect(JSON.parse(readFileSync(marker.target, "utf8"))).toEqual(nextDocument);
		expect(existsSync(marker.staging)).toBe(false);
		expect(
			existsSync(durableFileTransactionMarkerPath(dirname(marker.target), marker.target)),
		).toBe(false);
	});

	it("pages more than one hundred configured models through validated Host responses", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		await data(runtime, "provider.customUpsert", {
			providerId: "large-catalog",
			name: "Large Catalog",
			baseUrl: "http://127.0.0.1:11434/v1",
			models: Array.from({ length: 205 }, (_, index) => ({
				id: `model-${String(index).padStart(3, "0")}`,
			})),
		});

		const found: Array<{ providerId: string; modelId: string }> = [];
		let cursor: { providerId: string; modelId: string } | undefined;
		do {
			const page = (await data(runtime, "model.pool.get", {
				...(cursor ? { cursor } : {}),
				limit: 100,
			})) as {
				models: Array<{ providerId: string; modelId: string }>;
				nextCursor?: { providerId: string; modelId: string };
			};
			found.push(...page.models.filter((model) => model.providerId === "large-catalog"));
			cursor = page.nextCursor;
		} while (cursor);

		expect(found).toHaveLength(205);
		expect(new Set(found.map((model) => model.modelId)).size).toBe(205);
	});
	it("imports every catalog model idempotently when a provider fragment has no explicit routes", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const listed = (await data(runtime, "provider.list", {})) as {
			providers: Array<{ id: string; availableModels: Array<{ id: string }> }>;
		};
		const provider = listed.providers.find((candidate) => candidate.availableModels.length > 0);
		if (!provider) throw new Error("test catalog has no provider models");

		const configJson = JSON.stringify({
			providers: { [provider.id]: { baseUrl: "https://relay.example/v1" } },
		});
		await data(runtime, "provider.importPiConfig", { configJson });
		await data(runtime, "provider.importPiConfig", { configJson });
		const pool = (await data(runtime, "model.pool.get", {})) as {
			models: Array<{ providerId: string; modelId: string }>;
		};
		const importedIds = pool.models
			.filter((model) => model.providerId === provider.id)
			.map((model) => model.modelId)
			.sort();
		const catalogIds = provider.availableModels.map((model) => model.id).sort();
		expect(importedIds).toEqual(catalogIds);
	});

	function oauthDispatcher(
		state: { providerId: string; status: "completed" | "failed" },
		answerState = state,
	) {
		const syncedModels: Array<{
			providerId: string;
			providerName: string;
			modelId: string;
			label: string;
			supportsImages: boolean;
			enabled: boolean;
			readiness: "ready";
			createdAt: string;
		}> = [];
		const provider = {
			id: "oauth-relay",
			name: "OAuth Relay",
			availableModels: [{ id: "oauth-model", name: "OAuth Model", supportsImages: true }],
		};
		const projectionFacts = {
			providers: [{ providerId: provider.id, providerName: provider.name, authenticated: true }],
			catalogModels: [{ providerId: provider.id, modelId: "oauth-model" }],
			removingProviderIds: [],
		};
		const providers = {
			getOAuthSession: vi.fn(async () => ({ ...state, events: [] })),
			answerOAuth: vi.fn(() => ({ ...answerState, events: [] })),
			listProviders: vi.fn(async () => [provider]),
			modelProjectionFacts: () => projectionFacts,
		};
		const orm = {
			select: () => ({
				from: () => ({
					where: () => ({
						get: () => undefined,
						orderBy: () => ({ limit: () => ({ get: () => undefined }) }),
					}),
				}),
			}),
		};
		const characterLoader = {
			getActiveCharacterId: () => "oauth-character",
			load: () => ({ id: "oauth-character", canon: {}, state: {} }),
			seed: vi.fn(),
			activate: vi.fn(),
		};
		const dispatcher = new Dispatcher();
		wireHostHandlers(dispatcher, {
			orm,
			invalidations: { invalidate: vi.fn() },
			livePush: vi.fn(),
			canon: { syncPackage: vi.fn() },
			onboarding: { initialize: vi.fn() },
			characterLoader,
			companionStore: { reconcileSchema: vi.fn() },
			defaultCharacterId: "oauth-character",
			providers,
			models: {
				sync: (input: {
					providerId: string;
					modelId: string;
					label: string;
					supportsImages: boolean;
				}) => {
					const model = {
						...input,
						providerName: provider.name,
						enabled: true,
						readiness: "ready" as const,
						createdAt: "2026-01-01T00:00:00.000Z",
					};
					const index = syncedModels.findIndex(
						(candidate) =>
							candidate.providerId === input.providerId && candidate.modelId === input.modelId,
					);
					if (index < 0) syncedModels.push(model);
					else syncedModels[index] = model;
					return model;
				},
				list: () => [...syncedModels],
			},
		} as unknown as HostCompositionContext);
		return { dispatcher, providers };
	}

	it("keeps OAuth status queries read-only even after completion", async () => {
		const failed = oauthDispatcher({ providerId: "oauth-relay", status: "failed" });
		await expect(
			failed.dispatcher.dispatch("provider.loginStatus", { providerId: "oauth-relay" }),
		).resolves.toMatchObject({ ok: true, data: { status: "failed" } });
		await expect(failed.dispatcher.dispatch("model.pool.get", {})).resolves.toMatchObject({
			ok: true,
			data: { models: [] },
		});
		const missing = oauthDispatcher({ providerId: "oauth-relay", status: "failed" });
		missing.providers.getOAuthSession.mockRejectedValue({
			kind: "not_found",
			reason: "oauth_session_not_found",
		});
		await expect(
			missing.dispatcher.dispatch("provider.loginStatus", { providerId: "oauth-relay" }),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "not_found", reason: "oauth_session_not_found" },
		});
		await expect(missing.dispatcher.dispatch("model.pool.get", {})).resolves.toMatchObject({
			ok: true,
			data: { models: [] },
		});

		const completed = oauthDispatcher({ providerId: "oauth-relay", status: "completed" });
		await expect(
			completed.dispatcher.dispatch("provider.loginStatus", { providerId: "oauth-relay" }),
		).resolves.toMatchObject({ ok: true, data: { status: "completed" } });
		await expect(completed.dispatcher.dispatch("model.pool.get", {})).resolves.toMatchObject({
			ok: true,
			data: { models: [] },
		});
	});

	it("synchronizes a model returned by the completed OAuth answer path", async () => {
		const { dispatcher } = oauthDispatcher(
			{ providerId: "oauth-relay", status: "failed" },
			{ providerId: "oauth-relay", status: "completed" },
		);
		await expect(
			dispatcher.dispatch("provider.loginAnswer", {
				providerId: "oauth-relay",
				answer: "finished",
			}),
		).resolves.toMatchObject({ ok: true, data: { status: "completed" } });
		await expect(dispatcher.dispatch("model.pool.get", {})).resolves.toMatchObject({
			ok: true,
			data: {
				models: [
					{
						providerId: "oauth-relay",
						providerName: "OAuth Relay",
						modelId: "oauth-model",
						label: "OAuth Model",
						supportsImages: true,
						enabled: true,
						readiness: "ready",
					},
				],
			},
		});
	});
});
