// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import { type CredentialVault, createHostRuntime } from "../src/index.js";

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
		await expect(data(runtime, "conversation.list:v1", {})).resolves.toMatchObject({
			conversations: [{ title: "与极昼" }],
		});
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
