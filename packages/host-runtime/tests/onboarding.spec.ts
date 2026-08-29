// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRepository } from "../src/conversations/repository.js";
import {
	type CredentialVault,
	createHostRuntime,
	HOST_SETTINGS_CAPABILITIES,
	type HostRuntime,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const vault: CredentialVault = {
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

function runtimeForTest(existingDataDir?: string) {
	const dataDir = existingDataDir ?? mkdtempSync(join(tmpdir(), "bear-onboarding-"));
	if (!existingDataDir) temporaryDirectories.push(dataDir);
	return createHostRuntime({
		dataDir,
		characterSeedRoot: characterRoot,
		productConfig,
		credentialVault: vault,
	});
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
	const current = (await data(runtime, "onboarding.get:v1", {})) as {
		status: string;
		currentStepId?: string;
	};
	if (current.status === "complete") return current;
	if (current.currentStepId === "welcome")
		await data(runtime, "onboarding.submit:v1", { stepId: "welcome" });
	return data(runtime, "onboarding.submit:v1", { stepId: "nickname", answer: "林" });
}

describe("role-defined onboarding", () => {
	afterEach(async () => {
		for (const directory of temporaryDirectories.splice(0))
			rmSync(directory, { recursive: true, force: true });
	});

	it("reads model pools and completed OAuth status without writing canonical state", async () => {
		const runtime = runtimeForTest();
		try {
			await data(runtime, "provider.customUpsert:v1", {
				providerId: "read-only-test",
				name: "Read only",
				baseUrl: "https://example.invalid/v1",
				models: [{ id: "test-model" }],
			});
			const composition = (
				runtime as unknown as {
					composition: { providers: { getOAuthSession: (id: string) => unknown } };
				}
			).composition;
			vi.spyOn(composition.providers, "getOAuthSession").mockReturnValue({
				providerId: "read-only-test",
				status: "completed",
			});
			const before = await runtime.dispatch("model.pool.get:v1", {});
			expect(before.ok).toBe(true);
			if (!before.ok) throw new Error("model pool unavailable");
			for (const channel of [
				"model.pool.get:v1",
				"onboarding.get:v1",
				"conversation.activeGet:v1",
				"provider.loginStatus:v1",
				"character.pluginTrustGet:v1",
				"snapshot.get:v1",
			]) {
				const response = await runtime.dispatch(
					channel,
					channel === "provider.loginStatus:v1"
						? { providerId: "read-only-test" }
						: channel === "character.pluginTrustGet:v1"
							? { characterId: productConfig.defaultCharacterId }
							: {},
				);
				const changes = (
					Reflect.get(runtime, "db") as import("../src/storage/database.js").Database
				).connection
					.prepare("SELECT source FROM sync_changes WHERE revision > ?")
					.all(before.sync?.revision ?? 0);
				expect(response, `${channel}: ${JSON.stringify(changes)}`).toMatchObject({
					ok: true,
					sync: before.sync,
				});
			}
		} finally {
			await runtime.close();
		}
	});

	it("replays from zero across pages then pushes live events until disposed", async () => {
		const runtime = runtimeForTest();
		try {
			const bus = (
				runtime as unknown as {
					composition: { eventBus: import("../src/storage/event-bus.js").EventBus };
				}
			).composition.eventBus;
			for (let index = 0; index < 105; index++)
				bus.publish("provider.login_changed", { providerId: "openai-codex" });
			const receive = vi.fn();
			const stop = runtime.subscribeEvents(receive, 0);
			const replayCount = receive.mock.calls.length;
			expect(replayCount).toBeGreaterThanOrEqual(105);
			const next = bus.publish("memory.embedding_download_changed", {
				status: "downloading",
				downloadedBytes: 1024,
			});
			expect(receive).toHaveBeenLastCalledWith(next);
			stop();
			bus.publish("provider.login_changed", { providerId: "openai-codex" });
			expect(receive).toHaveBeenCalledTimes(replayCount + 1);
		} finally {
			await runtime.close();
		}
	});

	it("presents a minimal first meeting and persists the requested nickname", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		await expect(data(runtime, "onboarding.get:v1", {})).resolves.toMatchObject({
			status: "active",
			currentStepId: "welcome",
			stateData: {
				decisions: {
					relationship_memory_enabled: true,
					conversation_history_read_enabled: true,
				},
			},
		});
		await expect(completeOnboarding(runtime)).resolves.toMatchObject({
			status: "complete",
			stateData: { answers: { nickname: "林" } },
		});
		await data(runtime, "settings.set:v1", { settings: { relationshipMemoryEnabled: false } });
		await expect(data(runtime, "onboarding.get:v1", {})).resolves.toMatchObject({
			stateData: {
				answers: { nickname: "林" },
				decisions: { relationship_memory_enabled: false },
			},
		});
		const conversations = (await data(runtime, "conversation.list:v1", {})) as {
			conversations: Array<{ id: string; title: string }>;
		};
		expect(conversations.conversations).toHaveLength(1);
		expect(conversations.conversations[0]).toMatchObject({ title: "与极昼" });
		const conversationId = conversations.conversations[0]?.id;
		expect(conversationId).toBeTruthy();
		await expect(data(runtime, "conversation.activeGet:v1", {})).resolves.toMatchObject({
			conversation: { id: conversationId, title: "与极昼" },
		});
		await expect(data(runtime, "onboarding.get:v1", {})).resolves.toMatchObject({
			status: "complete",
		});
		await expect(data(runtime, "conversation.list:v1", {})).resolves.toMatchObject({
			conversations: [{ id: conversationId }],
		});
		await expect(
			data(runtime, "conversation.archive:v1", { id: conversationId, archived: true }),
		).resolves.toBeDefined();
		await expect(data(runtime, "conversation.list:v1", {})).resolves.toEqual({
			conversations: [],
		});
		await expect(data(runtime, "conversation.list:v1", { archived: true })).resolves.toMatchObject({
			conversations: [{ id: conversationId }],
		});
		await expect(
			data(runtime, "conversation.archive:v1", { id: conversationId, archived: false }),
		).resolves.toBeDefined();
		await expect(data(runtime, "conversation.list:v1", {})).resolves.toMatchObject({
			conversations: [{ id: conversationId }],
		});
		await runtime.close();
	});

	it("rolls back repository-owned onboarding completion and retries exactly once", async () => {
		const runtime = runtimeForTest();
		await runtime.start();
		const composition = Reflect.get(runtime, "composition") as {
			conversationRepository: ConversationRepository;
		};
		const repository = composition.conversationRepository;
		const createAndSelect = repository.createAndSelect.bind(repository);
		let failCallback = true;
		repository.createAndSelect = (input) => {
			if (!failCallback) return createAndSelect(input);
			failCallback = false;
			return createAndSelect({
				...input,
				onCommit: (transaction) => {
					input.onCommit?.(transaction);
					throw new Error("injected onboarding completion failure");
				},
			});
		};

		await expect(completeOnboarding(runtime)).rejects.toThrow("internal");

		const database = Reflect.get(runtime, "db") as {
			connection: { prepare(sql: string): { get(): unknown } };
		};
		const rowCount = (table: string) => {
			const row = database.connection.prepare(`SELECT count(*) AS count FROM ${table}`).get();
			if (
				typeof row !== "object" ||
				row === null ||
				!("count" in row) ||
				typeof row.count !== "number"
			) {
				throw new Error(`unexpected count row for ${table}`);
			}
			return row.count;
		};
		expect(rowCount("conversations")).toBe(0);
		expect(rowCount("conversation_sessions")).toBe(0);
		expect(rowCount("active_conversations")).toBe(0);

		await expect(completeOnboarding(runtime)).resolves.toMatchObject({ status: "complete" });
		await expect(data(runtime, "conversation.list:v1", {})).resolves.toMatchObject({
			conversations: [{ title: "与极昼" }],
		});
		expect(rowCount("conversations")).toBe(1);
		expect(rowCount("conversation_sessions")).toBe(1);
		expect(rowCount("active_conversations")).toBe(1);
		await runtime.close();
	});

	it("pairs onboarding and snapshot projections with a monotonic event cursor", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		const initial = (await data(runtime, "onboarding.get:v1", {})) as { eventSeq: number };
		const transitioned = (await completeOnboarding(runtime)) as {
			status: string;
			eventSeq: number;
		};
		const snapshot = (await data(runtime, "snapshot.get:v1", {})) as {
			eventSeq: number;
			onboarding: { status: string; eventSeq: number };
		};

		expect(transitioned).toMatchObject({ status: "complete" });
		expect(transitioned.eventSeq).toBeGreaterThan(initial.eventSeq);
		expect(snapshot.onboarding).toMatchObject({
			status: "complete",
			eventSeq: snapshot.eventSeq,
		});
		expect(snapshot.eventSeq).toBeGreaterThanOrEqual(transitioned.eventSeq);
		await runtime.close();
	});

	it("keeps internal Pi session fields out of the strict boot snapshot", async () => {
		const runtime = runtimeForTest();
		await runtime.start();
		await completeOnboarding(runtime);

		const snapshot = (await data(runtime, "snapshot.get:v1", {})) as {
			conversation: Record<string, unknown>;
		};
		expect(snapshot.conversation).toMatchObject({ activeConversationId: expect.any(String) });
		expect(snapshot.conversation).not.toHaveProperty("piSessionId");
		expect(snapshot.conversation).not.toHaveProperty("piLiveState");
		await runtime.close();
	});

	it("applies the global reply default to the conversation created on completion", async () => {
		const runtime = runtimeForTest();
		await runtime.start();
		const providerList = (await data(runtime, "provider.list:v1", {})) as {
			providers: Array<{ id: string; availableModels: Array<{ id: string; name: string }> }>;
		};
		const provider = providerList.providers.find(
			(candidate) => candidate.availableModels.length > 0,
		);
		const model = provider?.availableModels[0];
		if (!provider || !model) throw new Error("test provider catalog has no preset model");
		await data(runtime, "model.enable:v1", {
			providerId: provider.id,
			modelId: model.id,
			label: model.name,
		});
		await data(runtime, "model.defaults.setReply:v1", {
			reply: { providerId: provider.id, modelId: model.id },
		});
		await completeOnboarding(runtime);
		const list = (await data(runtime, "conversation.list:v1", {})) as {
			conversations: Array<{ id: string }>;
		};
		const conversationId = list.conversations[0]?.id;
		expect(conversationId).toBeTruthy();
		await expect(data(runtime, "model.route.get:v1", { conversationId })).resolves.toMatchObject({
			selected: { providerId: provider.id, modelId: model.id },
		});
		await runtime.close();
	});

	it("exposes only settings with a persisted Host effect", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		await expect(data(runtime, "settings.get:v1", {})).resolves.toEqual({
			settings: {
				firstRunStage: "model",
				relationshipMemoryEnabled: true,
				conversationHistoryReadEnabled: true,
				networkProxy: { mode: "auto" },
				memoryVectorService: { enabled: false, provider: "none" },
				modelDownloadSource: { type: "official" },
			},
		});
		await data(runtime, "settings.set:v1", { settings: { conversationHistoryReadEnabled: true } });
		await expect(data(runtime, "settings.get:v1", {})).resolves.toMatchObject({
			settings: { conversationHistoryReadEnabled: true },
		});
		await expect(
			runtime.dispatch("settings.set:v1", { settings: { immersionLevel: "roleplay" } }),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "invalid_request" },
		});
		await runtime.close();
	});

	it("projects and applies the Host-owned settings capability catalog", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		await expect(data(runtime, "settings.capabilitiesGet:v1", {})).resolves.toEqual({
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
			.spyOn(runtime.memoryRuntime, "configureLocalEmbedding")
			.mockResolvedValue(undefined);
		await expect(
			data(runtime, "memory.configureLocalEmbedding:v1", {
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
		await expect(data(runtime, "settings.get:v1", {})).resolves.toMatchObject({
			settings: {
				memoryVectorService: {
					enabled: true,
					provider: "local",
					localModel: candidate?.id,
				},
			},
		});
		await expect(
			runtime.dispatch("memory.configureLocalEmbedding:v1", {
				provider: "local",
				candidateId: "not-in-the-host-catalog",
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "invalid_request", reason: "local_embedding_candidate_not_found" },
		});
		await expect(
			runtime.dispatch("settings.set:v1", {
				settings: { memoryVectorService: { enabled: true, provider: "none" } },
			}),
		).resolves.toMatchObject({ ok: false, error: { kind: "invalid_request" } });
		await expect(
			runtime.dispatch("settings.set:v1", {
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
			runtime.dispatch("settings.set:v1", {
				settings: { networkProxy: { mode: "manual", url: "not-a-proxy" } },
			}),
		).resolves.toMatchObject({ ok: false, error: { kind: "invalid_request" } });

		const configureRemote = vi
			.spyOn(runtime.memoryRuntime, "configureRemoteEmbedding")
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
			runtime.dispatch("settings.set:v1", {
				settings: { memoryVectorService: remoteSettings },
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "unavailable", reason: "remote_embedding_validation_failed" },
		});
		await expect(data(runtime, "settings.get:v1", {})).resolves.toMatchObject({
			settings: { memoryVectorService: { provider: "local" } },
		});
		configureRemote.mockResolvedValue({ ready: true });
		await data(runtime, "settings.set:v1", {
			settings: { memoryVectorService: remoteSettings },
		});
		expect(configureRemote).toHaveBeenCalledWith({
			baseUrl: "https://embedding.example/v1",
			apiKey: "test-key",
			model: "test-embedding",
			dimensions: 768,
		});
		await expect(data(runtime, "settings.get:v1", {})).resolves.toMatchObject({
			settings: { memoryVectorService: { provider: "remote", model: "test-embedding" } },
		});
		await runtime.close();
	});

	it("reports embedding download bytes and cancels without saving the candidate", async () => {
		const runtime = runtimeForTest();
		await runtime.start();
		const before = await data(runtime, "settings.get:v1", {});
		const received = vi.fn();
		const stop = runtime.subscribeEvents(received, 0);
		vi.spyOn(runtime.memoryRuntime, "configureLocalEmbedding").mockImplementation(
			async (options) => {
				options.onProgress?.({ downloadedSize: 25, totalSize: 100 });
				await new Promise<void>((_resolve, reject) =>
					options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
						once: true,
					}),
				);
				return { ready: true };
			},
		);
		const configure = runtime.dispatch("memory.configureLocalEmbedding:v1", {
			provider: "local",
			customPath: "hf:test/model.gguf",
		});
		await vi.waitFor(async () =>
			expect(await data(runtime, "memory.localEmbeddingDownloadStatus:v1", {})).toEqual({
				status: "downloading",
				downloadedBytes: 25,
				totalBytes: 100,
			}),
		);
		expect(received).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "memory.embedding_download_changed",
				payload: { status: "downloading", downloadedBytes: 25, totalBytes: 100 },
			}),
		);
		await expect(
			runtime.dispatch("memory.configureLocalEmbedding:v1", { provider: "none" }),
		).resolves.toMatchObject({ ok: false, error: { reason: "embedding_download_in_progress" } });
		await data(runtime, "memory.cancelLocalEmbeddingDownload:v1", {});
		await expect(configure).resolves.toMatchObject({
			ok: false,
			error: { reason: "embedding_download_cancelled" },
		});
		expect(await data(runtime, "memory.localEmbeddingDownloadStatus:v1", {})).toMatchObject({
			status: "cancelled",
		});
		expect(await data(runtime, "settings.get:v1", {})).toEqual(before);
		expect(received).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "memory.embedding_download_changed",
				payload: { status: "cancelled", downloadedBytes: 25, totalBytes: 100 },
			}),
		);
		stop();
		await runtime.close();
	});

	it("projects an absent or cancelled OAuth session as idle with a Host invalidation", async () => {
		const runtime = runtimeForTest();
		const changed = vi.fn();
		const stop = runtime.subscribeEvents(changed, 0);
		try {
			await expect(
				data(runtime, "provider.loginStatus:v1", { providerId: "openai-codex" }),
			).resolves.toEqual({ providerId: "openai-codex", status: "idle" });
			vi.spyOn(runtime.providers, "cancelOAuth").mockImplementation(() => undefined);
			await data(runtime, "provider.loginCancel:v1", { providerId: "openai-codex" });
			expect(changed).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "provider.login_changed",
					payload: { providerId: "openai-codex" },
				}),
			);
			await expect(
				data(runtime, "provider.loginStatus:v1", { providerId: "openai-codex" }),
			).resolves.toMatchObject({ status: "idle" });
		} finally {
			stop();
			await runtime.close();
		}
	});

	it("aborts downloads on Host close and ignores late downloader callbacks", async () => {
		const runtime = runtimeForTest();
		const dataDir = temporaryDirectories.at(-1)!;
		await runtime.start();
		const gate = Promise.withResolvers<void>();
		let captured: Parameters<typeof runtime.memoryRuntime.configureLocalEmbedding>[0] | undefined;
		vi.spyOn(runtime.memoryRuntime, "configureLocalEmbedding").mockImplementation(
			async (options) => {
				captured = options;
				await gate.promise;
			},
		);
		const command = runtime.dispatch("memory.configureLocalEmbedding:v1", {
			provider: "local",
			customPath: "hf:test/model.gguf",
		});
		await vi.waitFor(() => expect(captured).toBeDefined());
		await runtime.close();
		expect(captured!.signal!.aborted).toBe(true);
		captured!.onProgress?.({ downloadedSize: 100, totalSize: 100 });
		captured!.onPhase?.("activating");
		gate.resolve();
		await expect(command).resolves.toMatchObject({
			ok: false,
			error: { reason: "embedding_download_cancelled" },
		});
		await expect(runtime.dispatch("settings.get:v1", {})).resolves.toMatchObject({
			ok: false,
			error: { reason: "host_closed" },
		});
		const restarted = runtimeForTest(dataDir);
		await expect(
			data(restarted, "memory.localEmbeddingDownloadStatus:v1", {}),
		).resolves.toMatchObject({ status: "cancelled" });
		await restarted.close();
	});

	it("rejects persisted onboarding state from a different role flow version", async () => {
		const runtime = runtimeForTest();
		const database = Reflect.get(runtime, "db") as {
			connection: { prepare(sql: string): { run(...params: unknown[]): void } };
		};
		database.connection
			.prepare(
				"INSERT INTO onboarding_state (companion_id, state, state_json, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(companion_id) DO UPDATE SET state=excluded.state, state_json=excluded.state_json, updated_at=excluded.updated_at",
			)
			.run(
				productConfig.defaultCharacterId,
				"complete",
				JSON.stringify({
					schema_version: 1,
					flow_version: 1,
					answers: { nickname: "林", relationship: "collaborator" },
					decisions: { relationship_kind: "collaborator" },
				}),
			);

		await expect(runtime.dispatch("onboarding.get:v1", {})).resolves.toMatchObject({
			ok: false,
			error: { kind: "internal" },
		});
		await runtime.close();
	});

	it("rejects corrupt current-version state instead of treating it as legacy data", async () => {
		const runtime = runtimeForTest();
		const database = Reflect.get(runtime, "db") as {
			connection: { prepare(sql: string): { run(...params: unknown[]): void } };
		};
		database.connection
			.prepare(
				"INSERT INTO onboarding_state (companion_id, state, state_json, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(companion_id) DO UPDATE SET state=excluded.state, state_json=excluded.state_json, updated_at=excluded.updated_at",
			)
			.run(
				productConfig.defaultCharacterId,
				"welcome",
				JSON.stringify({ schema_version: 1, decisions: {} }),
			);

		await expect(runtime.dispatch("onboarding.get:v1", {})).resolves.toMatchObject({
			ok: false,
			error: { kind: "internal" },
		});
		await runtime.close();
	});

	it("rejects an answer for an information-only onboarding step", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		await expect(
			runtime.dispatch("onboarding.submit:v1", { stepId: "welcome", answer: "invalid" }),
		).resolves.toEqual({
			ok: false,
			error: { kind: "invalid_request", reason: "onboarding_answer_unexpected" },
		});
		await runtime.close();
	});
});
