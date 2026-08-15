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
			currentStepId: "door_closed",
		});
		await expect(
			data(runtime, "onboarding.submit:v1", { stepId: "door_closed" }),
		).resolves.toMatchObject({
			status: "active",
			currentStepId: "introduced",
		});
		await data(runtime, "onboarding.submit:v1", { stepId: "introduced" });
		await data(runtime, "onboarding.submit:v1", { stepId: "naming", answer: "林" });
		await data(runtime, "onboarding.submit:v1", { stepId: "relation", answer: "partner" });
		await expect(
			data(runtime, "onboarding.submit:v1", {
				stepId: "memory_decision",
				answer: "remember",
			}),
		).resolves.toMatchObject({
			status: "complete",
			stateData: {
				answers: { nickname: "林", relationship: "partner", relationship_memory: "remember" },
				decisions: { relationship_kind: "partner", relationship_memory_enabled: true },
			},
		});

		await expect(data(runtime, "settings.get:v1", {})).resolves.toMatchObject({
			settings: { relationshipMemoryEnabled: true },
		});
		await data(runtime, "settings.set:v1", { settings: { relationshipMemoryEnabled: false } });
		await expect(data(runtime, "onboarding.get:v1", {})).resolves.toMatchObject({
			stateData: {
				answers: { relationship_memory: "forget" },
				decisions: { relationship_memory_enabled: false },
			},
		});
		await expect(data(runtime, "conversation.list:v1", {})).resolves.toMatchObject({
			conversations: [{ title: "初次见面" }],
		});
		await runtime.close();
	});

	it("migrates a persisted voice gate into a completed role-defined flow", async () => {
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
				"voice_ready",
				JSON.stringify({ name: "林", relation: "partner", memoryEnabled: true }),
			);

		await expect(data(runtime, "onboarding.get:v1", {})).resolves.toMatchObject({
			status: "complete",
			stateData: {
				answers: { nickname: "林", relationship: "partner", relationship_memory: "remember" },
				decisions: { relationship_kind: "partner", relationship_memory_enabled: true },
			},
		});
		await expect(data(runtime, "conversation.list:v1", {})).resolves.toMatchObject({
			conversations: [{ title: "初次见面" }],
		});
		await runtime.close();
	});

	it("rejects a value outside the active role-defined choice set", async () => {
		const runtime = runtimeForTest();
		await runtime.start();
		await data(runtime, "onboarding.submit:v1", { stepId: "door_closed" });
		await data(runtime, "onboarding.submit:v1", { stepId: "introduced" });
		await data(runtime, "onboarding.submit:v1", { stepId: "naming", answer: "林" });

		await expect(
			runtime.dispatch("onboarding.submit:v1", { stepId: "relation", answer: "invalid" }),
		).resolves.toEqual({
			ok: false,
			error: { kind: "invalid_request", reason: "onboarding_answer_invalid" },
		});
		await runtime.close();
	});
});
