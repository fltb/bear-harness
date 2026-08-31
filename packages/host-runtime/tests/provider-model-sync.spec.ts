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
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
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

		await data(runtime, "provider.customUpsert:v1", input);
		await data(runtime, "provider.customUpsert:v1", input);
		const pool = (await data(runtime, "model.pool.get:v1", {})) as {
			models: Array<{
				providerId: string;
				modelId: string;
				label: string;
				supportsImages: boolean;
			}>;
		};
		expect(pool.models.filter((model) => model.providerId === "sync-relay")).toMatchObject([
			{ modelId: "vision", label: "Vision", supportsImages: true },
			{ modelId: "text", label: "Text", supportsImages: false },
		]);
		expect(pool.models.filter((model) => model.providerId === "sync-relay")).toHaveLength(2);

		await data(runtime, "provider.setApiKey:v1", {
			providerId: "sync-relay",
			apiKey: "session-key",
		});
		const afterKey = (await data(runtime, "model.pool.get:v1", {})) as typeof pool;
		expect(afterKey.models.filter((model) => model.providerId === "sync-relay")).toHaveLength(2);
		const listed = (await data(runtime, "provider.list:v1", {})) as {
			providers: Array<{ id: string; source: string; added: boolean }>;
		};
		expect(listed.providers.find((provider) => provider.id === "sync-relay")).toMatchObject({
			source: "custom",
			added: true,
		});
		await data(runtime, "model.defaults.setReply:v1", {
			reply: { providerId: "sync-relay", modelId: "text" },
		});
		await data(runtime, "model.defaults.setVision:v1", {
			mode: "manual",
			route: { providerId: "sync-relay", modelId: "vision" },
		});
		await data(runtime, "provider.remove:v1", { providerId: "sync-relay" });
		const afterRemove = (await data(runtime, "model.pool.get:v1", {})) as typeof pool;
		expect(afterRemove.models.some((model) => model.providerId === "sync-relay")).toBe(false);
		const defaults = (await data(runtime, "model.defaults.get:v1", {})) as {
			reply?: { providerId: string; modelId: string };
			vision: { mode: string };
		};
		expect(defaults.reply).toBeUndefined();
		expect(defaults.vision).toEqual({ mode: "auto" });
		const afterProviderRemove = (await data(runtime, "provider.list:v1", {})) as {
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
		await data(first, "provider.customUpsert:v1", {
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
		const listed = (await data(restarted, "provider.list:v1", {})) as {
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
	it("imports all catalog models when a provider fragment has no explicit model routes", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const listed = (await data(runtime, "provider.list:v1", {})) as {
			providers: Array<{ id: string; availableModels: Array<{ id: string }> }>;
		};
		const provider = listed.providers.find((candidate) => candidate.availableModels.length > 0);
		if (!provider) throw new Error("test catalog has no provider models");

		const configJson = JSON.stringify({
			providers: { [provider.id]: { baseUrl: "https://relay.example/v1" } },
		});
		await data(runtime, "provider.importPiConfig:v1", { configJson });
		await data(runtime, "provider.importPiConfig:v1", { configJson });
		const pool = (await data(runtime, "model.pool.get:v1", {})) as {
			models: Array<{ providerId: string; modelId: string }>;
		};
		const importedIds = pool.models
			.filter((model) => model.providerId === provider.id)
			.map((model) => model.modelId);
		expect(importedIds).toEqual(provider.availableModels.map((model) => model.id));
	});

	function oauthDispatcher(
		state: { providerId: string; status: "completed" | "failed" },
		answerState = state,
	) {
		const enable = vi.fn();
		const provider = {
			id: "oauth-relay",
			name: "OAuth Relay",
			availableModels: [{ id: "oauth-model", name: "OAuth Model", supportsImages: true }],
		};
		const providers = {
			getOAuthSession: vi.fn(async () => state),
			answerOAuth: vi.fn(() => answerState),
			listProviders: vi.fn(async () => [provider]),
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
			eventBus: { publish: vi.fn() },
			canon: { syncPackage: vi.fn() },
			onboarding: { initialize: vi.fn() },
			characterLoader,
			companionStore: { reconcileSchema: vi.fn() },
			defaultCharacterId: "oauth-character",
			providers,
			models: { enable },
		} as unknown as HostCompositionContext);
		return { dispatcher, providers, enable };
	}

	it("keeps OAuth status queries read-only even after completion", async () => {
		const failed = oauthDispatcher({ providerId: "oauth-relay", status: "failed" });
		await expect(
			failed.dispatcher.dispatch("provider.loginStatus:v1", { providerId: "oauth-relay" }),
		).resolves.toMatchObject({ ok: true, data: { status: "failed" } });
		expect(failed.providers.listProviders).not.toHaveBeenCalled();
		expect(failed.enable).not.toHaveBeenCalled();
		const missing = oauthDispatcher({ providerId: "oauth-relay", status: "failed" });
		missing.providers.getOAuthSession.mockRejectedValue({
			kind: "not_found",
			reason: "oauth_session_not_found",
		});
		await expect(
			missing.dispatcher.dispatch("provider.loginStatus:v1", { providerId: "oauth-relay" }),
		).resolves.toMatchObject({ ok: true, data: { providerId: "oauth-relay", status: "idle" } });
		expect(missing.providers.listProviders).not.toHaveBeenCalled();
		expect(missing.enable).not.toHaveBeenCalled();

		const completed = oauthDispatcher({ providerId: "oauth-relay", status: "completed" });
		await expect(
			completed.dispatcher.dispatch("provider.loginStatus:v1", { providerId: "oauth-relay" }),
		).resolves.toMatchObject({ ok: true, data: { status: "completed" } });
		expect(completed.enable).not.toHaveBeenCalled();
		expect(completed.providers.listProviders).not.toHaveBeenCalled();
	});

	it("synchronizes a model returned by the completed OAuth answer path", async () => {
		const { dispatcher, enable, providers } = oauthDispatcher(
			{ providerId: "oauth-relay", status: "failed" },
			{ providerId: "oauth-relay", status: "completed" },
		);
		await expect(
			dispatcher.dispatch("provider.loginAnswer:v1", {
				providerId: "oauth-relay",
				answer: "finished",
			}),
		).resolves.toMatchObject({ ok: true, data: { status: "completed" } });
		expect(providers.listProviders).toHaveBeenCalledTimes(1);
		expect(enable).toHaveBeenCalledTimes(1);
	});
});
