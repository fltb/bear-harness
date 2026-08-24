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

function runtimeForTest() {
	const dataDir = mkdtempSync(join(tmpdir(), "bear-onboarding-"));
	temporaryDirectories.push(dataDir);
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
				relationshipMemoryEnabled: true,
				conversationHistoryReadEnabled: true,
				networkProxy: { mode: "direct" },
				memoryVectorService: { enabled: false, provider: "none" },
				modelDownloadMirror: {},
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
				({ id, name, isDefault }) => ({ id, name, isDefault }),
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
		expect(configure).toHaveBeenCalledWith(candidate?.modelPath);
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
		await runtime.close();
	});

	it("rejects persisted onboarding state from a different role flow version", async () => {
		const runtime = runtimeForTest();
		const database = Reflect.get(runtime, "db") as {
			connection: { prepare(sql: string): { run(...params: unknown[]): void } };
		};
		database.connection
			.prepare(
				"INSERT INTO onboarding_state (companion_id, state, state_json, updated_at) VALUES (?, ?, ?, datetime('now'))",
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
				"INSERT INTO onboarding_state (companion_id, state, state_json, updated_at) VALUES (?, ?, ?, datetime('now'))",
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
