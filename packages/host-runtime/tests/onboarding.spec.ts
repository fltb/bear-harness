// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { CacheKey } from "@bear-harness/protocol/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CredentialVault,
	createHostRuntime,
	HOST_SETTINGS_CAPABILITIES,
	type HostRuntime,
} from "../src/index.js";
import type { CompanionDatabase, SystemDatabase } from "../src/storage/database.js";

const temporaryDirectories: string[] = [];
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const vault: CredentialVault = {
	securityLevel: "session",
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

function runtimeForTest(existingDataDir?: string, credentialVault: CredentialVault = vault) {
	const dataDir = existingDataDir ?? mkdtempSync(join(tmpdir(), "bear-onboarding-"));
	if (!existingDataDir) temporaryDirectories.push(dataDir);
	return createHostRuntime({
		dataDir,
		characterSeedRoot: characterRoot,
		productConfig,
		credentialVault,
	});
}

function runtimeDatabases(runtime: HostRuntime): {
	system: SystemDatabase;
	companion: CompanionDatabase;
} {
	const storage = Reflect.get(runtime, "storage") as { system: SystemDatabase };
	const role = roleRuntime(runtime);
	return { system: storage.system, companion: role.db };
}

function roleRuntime(runtime: HostRuntime): {
	companionId: string;
	db: CompanionDatabase;
	memoryRuntime: HostRuntime["memoryRuntime"];
	externalAgentRuns: object;
	invalidations: import("../src/storage/invalidation-hub.js").InvalidationHub;
	pi: { closeAll(): Promise<void> };
	auditStore: { flush(): Promise<void> };
	close(): Promise<void>;
} {
	const lifecycle = Reflect.get(runtime, "lifecycle") as {
		active(): { runtime: unknown };
	};
	return lifecycle.active().runtime as ReturnType<typeof roleRuntime>;
}

async function data(
	runtime: ReturnType<typeof createHostRuntime>,
	channel: string,
	params: unknown,
) {
	const response = await runtime.dispatch(channel, params);
	if (!response.ok) throw new Error(`${response.error.kind}: ${response.error.reason}`);
	return response.data;
}

async function completeOnboarding(runtime: HostRuntime) {
	const current = (await data(runtime, "onboarding.get", {})) as {
		status: string;
		currentStepId?: string;
	};
	if (current.status === "complete") return current;
	if (current.currentStepId === "welcome")
		await data(runtime, "onboarding.submit", { stepId: "welcome" });
	return data(runtime, "onboarding.submit", { stepId: "nickname", answer: "林" });
}

async function configureConversationModel(runtime: HostRuntime, providerId = "conversation-test") {
	await data(runtime, "provider.customUpsert", {
		providerId,
		name: "Conversation Test",
		baseUrl: "https://example.invalid/v1",
		models: [{ id: "test-model" }],
	});
	await data(runtime, "provider.setApiKey", {
		providerId,
		apiKey: "session-key",
		sessionOnly: true,
	});
	await data(runtime, "model.defaults.setReply", {
		reply: { providerId, modelId: "test-model" },
	});
}

describe("role-defined onboarding", () => {
	afterEach(async () => {
		for (const directory of temporaryDirectories.splice(0))
			rmSync(directory, { recursive: true, force: true });
	});

	it("pushes only live invalidations until disposed", async () => {
		const runtime = runtimeForTest();
		try {
			const bus = roleRuntime(runtime).invalidations;
			bus.invalidate(CacheKey.providers());
			const receive = vi.fn();
			const stop = runtime.subscribeInvalidations(receive);
			expect(receive).not.toHaveBeenCalled();
			bus.invalidate(CacheKey.settings());
			expect(receive).toHaveBeenLastCalledWith({
				keys: [["settings"]],
			});
			stop();
			bus.invalidate(CacheKey.providers());
			expect(receive).toHaveBeenCalledTimes(1);
		} finally {
			await runtime.close();
		}
	});

	it("presents a minimal first meeting and persists the requested nickname", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		await expect(data(runtime, "onboarding.get", {})).resolves.toMatchObject({
			status: "active",
			currentStepId: "welcome",
			stateData: {
				decisions: {
					relationship_memory_enabled: true,
				},
			},
		});
		await expect(completeOnboarding(runtime)).resolves.toMatchObject({
			status: "complete",
			stateData: { answers: { nickname: "林" } },
		});
		await data(runtime, "settings.set", { settings: { relationshipMemoryEnabled: false } });
		await expect(data(runtime, "onboarding.get", {})).resolves.toMatchObject({
			stateData: {
				answers: { nickname: "林" },
				decisions: { relationship_memory_enabled: false },
			},
		});
		await expect(data(runtime, "conversation.list", {})).resolves.toEqual({ conversations: [] });
		await configureConversationModel(runtime);
		const created = (await data(runtime, "conversation.create", {
			title: "与极昼",
		})) as { conversationId: string };
		await expect(
			data(runtime, "conversation.open", { conversationId: created.conversationId }),
		).resolves.toMatchObject({ conversationId: created.conversationId });
		const nickname = runtimeDatabases(runtime)
			.companion.connection.prepare("SELECT nickname FROM runtime_identity WHERE id = 1")
			.get();
		expect(nickname).toEqual({ nickname: "林" });
		await expect(data(runtime, "onboarding.get", {})).resolves.toMatchObject({
			status: "complete",
		});
		await runtime.close();
	});

	it("returns onboarding directly in the boot snapshot", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		const transitioned = (await completeOnboarding(runtime)) as { status: string };
		const snapshot = (await data(runtime, "snapshot.get", {})) as {
			onboarding: { status: string };
		};

		expect(transitioned).toMatchObject({ status: "complete" });
		expect(snapshot.onboarding).toMatchObject({ status: "complete" });
		await runtime.close();
	});

	it("keeps internal Pi session fields out of the strict boot snapshot", async () => {
		const runtime = runtimeForTest();
		await runtime.start();
		await completeOnboarding(runtime);

		const snapshot = (await data(runtime, "snapshot.get", {})) as Record<string, unknown>;
		expect(snapshot).not.toHaveProperty("conversation");
		expect(snapshot).not.toHaveProperty("companion");
		await runtime.close();
	});

	it("exposes only settings with a persisted Host effect", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		await expect(data(runtime, "settings.get", {})).resolves.toEqual({
			settings: {
				firstRunStage: "model",
				relationshipMemoryEnabled: true,
				networkProxy: { mode: "auto" },
				memoryVectorService: { enabled: false, provider: "none" },
				modelDownloadSource: { type: "official" },
			},
		});
		await expect(
			runtime.dispatch("settings.set", { settings: { immersionLevel: "resources" } }),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "invalid_request" },
		});
		await runtime.close();
	});

	it("projects and applies the Host-owned settings capability catalog", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		await expect(data(runtime, "settings.capabilitiesGet", {})).resolves.toEqual({
			networkProxyModes: HOST_SETTINGS_CAPABILITIES.networkProxyModes.map(({ id }) => ({ id })),
			memoryVectorProviders: HOST_SETTINGS_CAPABILITIES.memoryVectorProviders.map(
				({ id, onboarding }) => ({ id, onboarding }),
			),
			memoryVectorPresets: HOST_SETTINGS_CAPABILITIES.memoryVectorPresets.map(
				({ id, model, dimensions }) => ({ id, model, dimensions }),
			),
			localEmbeddingCandidates: HOST_SETTINGS_CAPABILITIES.localEmbeddingCandidates.map(
				({ id, name, dimensions, isDefault }) => ({ id, name, dimensions, isDefault }),
			),
		});

		const candidate = HOST_SETTINGS_CAPABILITIES.localEmbeddingCandidates[0];
		expect(candidate).toBeDefined();
		const configure = vi
			.spyOn(runtime.memoryEmbedding, "validateLocal")
			.mockResolvedValue(undefined);
		await expect(
			data(runtime, "memory.configureLocalEmbedding", {
				provider: "local",
				candidateId: candidate?.id,
			}),
		).resolves.toEqual({ ready: true });
		expect(configure).toHaveBeenCalledWith({
			modelPath: candidate?.modelPath,
			dimensions: 768,
			hfEndpoint: "https://huggingface.co",
			signal: expect.any(AbortSignal),
			onProgress: expect.any(Function),
			onPhase: expect.any(Function),
		});
		await expect(data(runtime, "settings.get", {})).resolves.toMatchObject({
			settings: {
				memoryVectorService: {
					enabled: true,
					provider: "local",
					localModel: candidate?.id,
				},
			},
		});
		await expect(
			runtime.dispatch("memory.configureLocalEmbedding", {
				provider: "local",
				candidateId: "not-in-the-host-catalog",
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "invalid_request", reason: "local_embedding_candidate_not_found" },
		});
		await expect(
			runtime.dispatch("settings.set", {
				settings: { memoryVectorService: { enabled: true, provider: "none" } },
			}),
		).resolves.toMatchObject({ ok: false, error: { kind: "invalid_request" } });
		await expect(
			runtime.dispatch("settings.set", {
				settings: {
					memoryVectorService: {
						enabled: true,
						provider: "remote",
						baseUrl: "not-a-url",
						apiKey: "test-key",
						model: "fake-model",
						dimensions: 1,
					},
				},
			}),
		).resolves.toMatchObject({ ok: false, error: { kind: "invalid_request" } });
		await expect(
			runtime.dispatch("settings.set", {
				settings: { networkProxy: { mode: "manual", url: "not-a-proxy" } },
			}),
		).resolves.toMatchObject({ ok: false, error: { kind: "invalid_request" } });

		const configureRemote = vi
			.spyOn(runtime.memoryEmbedding, "validateRemote")
			.mockRejectedValueOnce({ kind: "unavailable", reason: "remote_embedding_validation_failed" });
		const remoteSettings = {
			enabled: true as const,
			provider: "remote" as const,
			baseUrl: "https://embedding.example/v1",
			apiKey: "test-key",
			model: "test-embedding",
			dimensions: 768,
		};
		await expect(
			runtime.dispatch("settings.set", {
				settings: { memoryVectorService: remoteSettings },
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "unavailable", reason: "remote_embedding_validation_failed" },
		});
		await expect(data(runtime, "settings.get", {})).resolves.toMatchObject({
			settings: { memoryVectorService: { provider: "local" } },
		});
		configureRemote.mockResolvedValue({ ready: true });
		const savedRemote = await data(runtime, "settings.set", {
			settings: { memoryVectorService: remoteSettings },
		});
		expect(JSON.stringify(savedRemote)).not.toContain("test-key");
		expect(savedRemote).toMatchObject({
			settings: { memoryVectorService: { provider: "remote", hasCredential: true } },
		});
		expect(configureRemote).toHaveBeenCalledWith({
			baseUrl: "https://embedding.example/v1",
			apiKey: "test-key",
			model: "test-embedding",
			dimensions: 768,
		});
		const projected = await data(runtime, "settings.get", {});
		expect(projected).toMatchObject({
			settings: {
				memoryVectorService: {
					provider: "remote",
					model: "test-embedding",
					hasCredential: true,
				},
			},
		});
		expect(JSON.stringify(projected)).not.toContain("test-key");
		expect(JSON.stringify(projected)).not.toContain("apiKey");

		const databases = runtimeDatabases(runtime);
		const persistedConfig = databases.system.connection
			.prepare("SELECT memory_vector_service FROM app_settings WHERE id = 1")
			.get() as { memory_vector_service: string };
		expect(persistedConfig.memory_vector_service).not.toContain("test-key");
		expect(persistedConfig.memory_vector_service).not.toContain("apiKey");
		const credentialRow = databases.system.connection
			.prepare("SELECT credential_blob, credential_status FROM provider_accounts WHERE id = ?")
			.get("$bear:embedding:remote") as {
			credential_blob: Buffer | null;
			credential_status: string;
		};
		expect(credentialRow).toEqual({ credential_blob: null, credential_status: "session_only" });
		const eventTable = databases.companion.connection
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
			.get();
		expect(eventTable).toBeUndefined();
		const runtimeConfig = Reflect.get(Reflect.get(runtime.memoryRuntime, "core"), "cfg");
		expect(runtimeConfig.embedding.apiKey).toBe("test-key");

		configureRemote.mockClear();
		await data(runtime, "settings.set", {
			settings: {
				memoryVectorService: {
					enabled: true,
					provider: "remote",
					baseUrl: remoteSettings.baseUrl,
					model: "replacement-model",
					dimensions: remoteSettings.dimensions,
				},
			},
		});
		expect(configureRemote).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: "test-key", model: "replacement-model" }),
		);
		await runtime.close();
	});

	it("keeps embedding configuration global and relationship memory lazy", async () => {
		const runtime = runtimeForTest();
		const dataDir = temporaryDirectories.at(-1)!;
		await runtime.start();
		const role = roleRuntime(runtime);
		const dormant = runtime.memoryRuntime;
		expect(dormant.isStarted()).toBe(false);
		expect(existsSync(join(dataDir, "memory"))).toBe(false);
		expect(existsSync(join(dataDir, "companions", "jizhou", "memory", "tdai"))).toBe(true);

		const first = runtime.memoryRuntime;
		expect(first).toBe(dormant);
		await first.start();
		expect(first.isStarted()).toBe(true);
		expect(Reflect.get(role, "memory")).toBe(first);
		const validate = vi
			.spyOn(runtime.memoryEmbedding, "validateRemote")
			.mockResolvedValue({ ready: true });
		const remote = {
			enabled: true as const,
			provider: "remote" as const,
			baseUrl: "https://embedding.example/v1",
			apiKey: "test-key",
			model: "global-embedding",
			dimensions: 768,
		};
		await data(runtime, "settings.set", { settings: { memoryVectorService: remote } });
		expect(validate).toHaveBeenCalledOnce();
		expect(Reflect.get(role, "memory")).toBeUndefined();
		await expect(first.start()).rejects.toThrow(/closed/);
		const nextFirst = runtime.memoryRuntime;
		expect(nextFirst).not.toBe(first);
		const config = Reflect.get(Reflect.get(nextFirst, "core"), "cfg");
		expect(config.embedding).toMatchObject({
			provider: "remote",
			apiKey: "test-key",
			model: "global-embedding",
			dimensions: 768,
		});
		const storedSystemConfig = runtimeDatabases(runtime)
			.system.connection.prepare("SELECT memory_vector_service FROM app_settings WHERE id = 1")
			.get() as { memory_vector_service: string };
		expect(JSON.parse(storedSystemConfig.memory_vector_service)).toMatchObject({
			provider: "remote",
			model: "global-embedding",
		});
		expect(storedSystemConfig.memory_vector_service).not.toContain("apiKey");
		expect(storedSystemConfig.memory_vector_service).not.toContain("test-key");
		await data(runtime, "memory.configureLocalEmbedding", { provider: "none" });

		await data(runtime, "settings.set", {
			settings: { relationshipMemoryEnabled: true },
		});
		const lazyMemory = runtime.memoryRuntime;
		await lazyMemory.start();
		expect(lazyMemory.isStarted()).toBe(true);
		await data(runtime, "settings.set", {
			settings: { relationshipMemoryEnabled: false },
		});
		expect(Reflect.get(role, "memory")).toBeUndefined();
		await expect(lazyMemory.start()).rejects.toThrow(/closed/);
		await runtime.close();
	});

	it("restores the remote embedding key from the encrypted vault without projecting it", async () => {
		const secureVault: CredentialVault = {
			securityLevel: "os",
			isEncryptionAvailable: () => true,
			encryptString: (value) => Buffer.from(Buffer.from(value).toString("base64")),
			decryptString: (value) => Buffer.from(value.toString(), "base64").toString(),
		};
		const runtime = runtimeForTest(undefined, secureVault);
		const dataDir = temporaryDirectories.at(-1);
		if (!dataDir) throw new Error("test data directory missing");
		vi.spyOn(runtime.memoryEmbedding, "validateRemote").mockResolvedValue({ ready: true });
		await data(runtime, "settings.set", {
			settings: {
				memoryVectorService: {
					enabled: true,
					provider: "remote",
					baseUrl: "https://embedding.example/v1",
					apiKey: "persistent-embedding-secret",
					model: "persistent-model",
					dimensions: 768,
				},
			},
		});
		await runtime.close();

		const restarted = runtimeForTest(dataDir, secureVault);
		const projection = await data(restarted, "settings.get", {});
		expect(projection).toMatchObject({
			settings: { memoryVectorService: { provider: "remote", hasCredential: true } },
		});
		expect(JSON.stringify(projection)).not.toContain("persistent-embedding-secret");
		const config = Reflect.get(Reflect.get(restarted.memoryRuntime, "core"), "cfg");
		expect(config.embedding.apiKey).toBe("persistent-embedding-secret");
		const databases = runtimeDatabases(restarted);
		const settingsRow = databases.system.connection
			.prepare("SELECT memory_vector_service FROM app_settings WHERE id = 1")
			.get() as { memory_vector_service: string };
		expect(settingsRow.memory_vector_service).not.toContain("persistent-embedding-secret");
		const credentialRow = databases.system.connection
			.prepare("SELECT credential_blob FROM provider_accounts WHERE id = ?")
			.get("$bear:embedding:remote") as { credential_blob: Buffer };
		expect(credentialRow.credential_blob.toString()).not.toContain("persistent-embedding-secret");
		await restarted.close();
	});

	it("keeps character Run diagnostics out of the installation diagnostics sink", async () => {
		const runtime = runtimeForTest();
		try {
			const role = roleRuntime(runtime) as {
				externalAgentRuns: object;
				db: { path: string };
			};
			expect(Reflect.get(role.externalAgentRuns, "diagnostics")).toBeUndefined();
			expect(role.db.path).toContain(join("companions", productConfig.defaultCharacterId));
		} finally {
			await runtime.close();
		}
	});

	it("closes every character resource even when one close operation fails", async () => {
		const runtime = runtimeForTest();
		const role = roleRuntime(runtime) as {
			externalAgentRuns: { close(): Promise<void> };
			pi: { closeAll(): Promise<void> };
			memoryRuntime: { close(): Promise<void> };
			auditStore: { flush(): Promise<void> };
			close(): Promise<void>;
		};
		const firstFailure = new Error("run close failed");
		vi.spyOn(role.externalAgentRuns, "close").mockRejectedValueOnce(firstFailure);
		const closePi = vi.spyOn(role.pi, "closeAll");
		const closeMemory = vi.spyOn(role.memoryRuntime, "close");
		const flushAudit = vi.spyOn(role.auditStore, "flush");
		await expect(role.close()).rejects.toBe(firstFailure);
		expect(closePi).toHaveBeenCalledOnce();
		expect(closeMemory).toHaveBeenCalledOnce();
		expect(flushAudit).toHaveBeenCalledOnce();
		await runtime.close();
	});

	it("reports embedding download bytes and cancels without saving the candidate", async () => {
		const runtime = runtimeForTest();
		await runtime.start();
		const before = await data(runtime, "settings.get", {});
		const received = vi.fn();
		const stop = runtime.subscribeLivePush(received);
		vi.spyOn(runtime.memoryEmbedding, "validateLocal").mockImplementation(async (options) => {
			options.onProgress?.({ downloadedSize: 25, totalSize: 100 });
			await new Promise<void>((_resolve, reject) =>
				options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
					once: true,
				}),
			);
			return { ready: true };
		});
		const configure = runtime.dispatch("memory.configureLocalEmbedding", {
			provider: "local",
			customPath: "hf:test/model.gguf",
		});
		await vi.waitFor(async () =>
			expect(await data(runtime, "memory.localEmbeddingDownloadStatus", {})).toEqual({
				status: "downloading",
				downloadedBytes: 25,
				totalBytes: 100,
			}),
		);
		expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: "embeddingDownload" }));
		await expect(
			runtime.dispatch("memory.configureLocalEmbedding", { provider: "none" }),
		).resolves.toMatchObject({ ok: false, error: { reason: "embedding_download_in_progress" } });
		await data(runtime, "memory.cancelLocalEmbeddingDownload", {});
		await expect(configure).resolves.toMatchObject({
			ok: false,
			error: { reason: "embedding_download_cancelled" },
		});
		expect(await data(runtime, "memory.localEmbeddingDownloadStatus", {})).toMatchObject({
			status: "cancelled",
		});
		expect(await data(runtime, "settings.get", {})).toEqual(before);
		expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: "embeddingDownload" }));
		stop();
		await runtime.close();
	});

	it("reports an absent or cancelled OAuth session and emits cancellation invalidation", async () => {
		const runtime = runtimeForTest();
		const changed = vi.fn();
		const stop = runtime.subscribeLivePush(changed);
		try {
			await expect(
				runtime.dispatch("provider.loginStatus", { providerId: "openai-codex" }),
			).resolves.toMatchObject({
				ok: false,
				error: { kind: "not_found", reason: "oauth_session_not_found" },
			});
			vi.spyOn(runtime.providers, "cancelOAuth").mockImplementation(() => undefined);
			await data(runtime, "provider.loginCancel", { providerId: "openai-codex" });
			expect(changed).toHaveBeenCalledWith({
				type: "providerLogin",
				providerId: "openai-codex",
				state: {
					providerId: "openai-codex",
					status: "failed",
					message: "cancelled",
				},
			});
			await expect(
				runtime.dispatch("provider.loginStatus", { providerId: "openai-codex" }),
			).resolves.toMatchObject({
				ok: false,
				error: { kind: "not_found", reason: "oauth_session_not_found" },
			});
		} finally {
			stop();
			await runtime.close();
		}
	});

	it("aborts downloads on Host close and ignores late downloader callbacks", async () => {
		const runtime = runtimeForTest();
		const dataDir = temporaryDirectories.at(-1)!;
		await runtime.start();
		let captured: Parameters<typeof runtime.memoryEmbedding.validateLocal>[0] | undefined;
		vi.spyOn(runtime.memoryEmbedding, "validateLocal").mockImplementation(async (options) => {
			captured = options;
			await new Promise<void>((_resolve, reject) =>
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				}),
			);
		});
		const command = runtime.dispatch("memory.configureLocalEmbedding", {
			provider: "local",
			customPath: "hf:test/model.gguf",
		});
		await vi.waitFor(() => expect(captured).toBeDefined());
		await runtime.close();
		expect(captured!.signal!.aborted).toBe(true);
		captured!.onProgress?.({ downloadedSize: 100, totalSize: 100 });
		captured!.onPhase?.("activating");
		await expect(command).resolves.toMatchObject({
			ok: false,
			error: { reason: "embedding_download_cancelled" },
		});
		await expect(runtime.dispatch("settings.get", {})).resolves.toMatchObject({
			ok: false,
			error: { reason: "host_closed" },
		});
		const restarted = runtimeForTest(dataDir);
		await expect(data(restarted, "memory.localEmbeddingDownloadStatus", {})).resolves.toMatchObject(
			{ status: "idle" },
		);
		await restarted.close();
	});

	it("resets invalid persisted onboarding state", async () => {
		const runtime = runtimeForTest();
		const database = runtimeDatabases(runtime).companion;
		database.connection
			.prepare(
				"INSERT INTO onboarding_state (companion_id, state, state_json, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(companion_id) DO UPDATE SET state=excluded.state, state_json=excluded.state_json, updated_at=excluded.updated_at",
			)
			.run(productConfig.defaultCharacterId, "welcome", JSON.stringify({ decisions: {} }));

		await expect(runtime.dispatch("onboarding.get", {})).resolves.toMatchObject({
			ok: true,
			data: {
				stateData: {
					answers: {},
					decisions: { relationship_memory_enabled: true },
				},
			},
		});
		await runtime.close();
	});

	it("rejects an answer for an information-only onboarding step", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		await expect(
			runtime.dispatch("onboarding.submit", { stepId: "welcome", answer: "invalid" }),
		).resolves.toEqual({
			ok: false,
			error: { kind: "invalid_request", reason: "onboarding_answer_unexpected" },
		});
		await runtime.close();
	});
});
