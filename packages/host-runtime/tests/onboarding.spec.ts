// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HOST_SETTINGS_CAPABILITIES,
	type CredentialVault,
	createHostRuntime,
} from "../src/index.js";
import type { ConversationRepository } from "../src/conversations/repository.js";

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
	return createHostRuntime({ dataDir, characterRoot, productConfig, credentialVault: vault });
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

describe("role-defined onboarding", () => {
	afterEach(async () => {
		for (const directory of temporaryDirectories.splice(0))
			rmSync(directory, { recursive: true, force: true });
	});

	it("validates role-defined answers, persists effects and completes without provider setup", async () => {
		const runtime = runtimeForTest();
		await runtime.start();

		await expect(data(runtime, "onboarding.get:v1", {})).resolves.toMatchObject({
			status: "active",
			currentStepId: "settings_intro",
		});
		await expect(
			data(runtime, "onboarding.submit:v1", { stepId: "settings_intro" }),
		).resolves.toMatchObject({
			status: "active",
			currentStepId: "nickname",
		});
		await data(runtime, "onboarding.submit:v1", { stepId: "nickname", answer: "林" });
		await data(runtime, "onboarding.submit:v1", { stepId: "relationship", answer: "collaborator" });
		await expect(
			data(runtime, "onboarding.submit:v1", {
				stepId: "memory",
				answer: "remember",
			}),
		).resolves.toMatchObject({
			status: "complete",
			stateData: {
				answers: { nickname: "林", relationship: "collaborator", relationship_memory: "remember" },
				decisions: { relationship_kind: "collaborator", relationship_memory_enabled: true },
			},
		});

		await expect(data(runtime, "settings.get:v1", {})).resolves.toMatchObject({
			settings: { relationshipMemoryEnabled: true },
		});
		await data(runtime, "settings.set:v1", { settings: { relationshipMemoryEnabled: false } });
		await expect(data(runtime, "onboarding.get:v1", {})).resolves.toMatchObject({
			stateData: {
				answers: { relationship_memory: "present" },
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

		for (const [stepId, answer] of [
			["settings_intro", undefined],
			["nickname", "林"],
			["relationship", "collaborator"],
			["memory", "remember"],
		] as const) {
			if (stepId === "memory") {
				await expect(data(runtime, "onboarding.submit:v1", { stepId, answer })).rejects.toThrow(
					"internal",
				);
			} else {
				await data(runtime, "onboarding.submit:v1", { stepId, answer });
			}
		}

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

		await expect(
			data(runtime, "onboarding.submit:v1", { stepId: "memory", answer: "remember" }),
		).resolves.toMatchObject({ status: "complete" });
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
		const transitioned = (await data(runtime, "onboarding.submit:v1", {
			stepId: "settings_intro",
		})) as { currentStepId: string; eventSeq: number };
		const snapshot = (await data(runtime, "snapshot.get:v1", {})) as {
			eventSeq: number;
			onboarding: { currentStepId: string; eventSeq: number };
		};

		expect(transitioned).toMatchObject({ currentStepId: "nickname" });
		expect(transitioned.eventSeq).toBeGreaterThan(initial.eventSeq);
		expect(snapshot.onboarding).toMatchObject({
			currentStepId: "nickname",
			eventSeq: snapshot.eventSeq,
		});
		expect(snapshot.eventSeq).toBeGreaterThanOrEqual(transitioned.eventSeq);
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
		for (const [stepId, answer] of [
			["settings_intro", undefined],
			["nickname", "林"],
			["relationship", "collaborator"],
			["memory", "remember"],
		] as const) {
			await data(runtime, "onboarding.submit:v1", { stepId, answer });
		}
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
				relationshipMemoryEnabled: false,
				conversationHistoryReadEnabled: false,
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
				"settings_intro",
				JSON.stringify({ schema_version: 1, decisions: {} }),
			);

		await expect(runtime.dispatch("onboarding.get:v1", {})).resolves.toMatchObject({
			ok: false,
			error: { kind: "internal" },
		});
		await runtime.close();
	});

	it("rejects a value outside the active role-defined choice set", async () => {
		const runtime = runtimeForTest();
		await runtime.start();
		await data(runtime, "onboarding.submit:v1", { stepId: "settings_intro" });
		await data(runtime, "onboarding.submit:v1", { stepId: "nickname", answer: "林" });

		await expect(
			runtime.dispatch("onboarding.submit:v1", { stepId: "relationship", answer: "invalid" }),
		).resolves.toEqual({
			ok: false,
			error: { kind: "invalid_request", reason: "onboarding_answer_invalid" },
		});
		await runtime.close();
	});
});
