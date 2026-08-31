// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CredentialVault, createHostRuntime } from "../src/index.js";

const roots: string[] = [];
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const vault: CredentialVault = {
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function data(
	runtime: ReturnType<typeof createHostRuntime>,
	channel: string,
	params: unknown,
) {
	const response = await runtime.dispatch(channel, params);
	if (!response.ok) throw new Error(`${response.error.kind}: ${response.error.reason}`);
	return response.data;
}

async function configureConversationModel(runtime: ReturnType<typeof createHostRuntime>) {
	await data(runtime, "provider.customUpsert:v1", {
		providerId: "state-test",
		name: "State Test",
		baseUrl: "https://example.invalid/v1",
		models: [{ id: "state-model" }],
	});
	await data(runtime, "provider.setApiKey:v1", {
		providerId: "state-test",
		apiKey: "session-key",
		sessionOnly: true,
	});
	await data(runtime, "model.defaults.setReply:v1", {
		reply: { providerId: "state-test", modelId: "state-model" },
	});
}

describe("character state RPC projection", () => {
	it("commits an intent, publishes an event, and exposes it through explicit conversation detail", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-character-state-rpc-"));
		roots.push(dataDir);
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		try {
			await configureConversationModel(runtime);
			const conversation = (await data(runtime, "conversation.create:v1", {
				title: "State projection",
			})) as { sessionId: string };
			const before = (await data(runtime, "companionState.get:v1", {
				conversationId: conversation.sessionId,
			})) as {
				state: {
					character: {
						document: { story: { summary: string } };
						revisions: { conversation: number; global: number };
					};
				};
			};
			const projection = before.state.character;
			expect(projection.document.story.summary).toBe("尚未开始。");

			const receive = vi.fn();
			const stop = runtime.subscribeEvents(receive, 0);
			const response = await data(runtime, "companionState.update:v1", {
				conversationId: conversation.sessionId,
				changes: [
					{
						path: "/character/story/summary",
						value: "两份记录都不足以确认最终接收者。",
					},
				],
			});
			expect(response).toEqual({});
			expect(receive.mock.calls.map(([event]) => event.kind)).toContain(
				"companion.snapshot_changed",
			);
			stop();

			const after = (await data(runtime, "companionState.get:v1", {
				conversationId: conversation.sessionId,
			})) as typeof before;
			expect(after.state.character.document.story.summary).toBe("两份记录都不足以确认最终接收者。");
			expect(after.state.character.revisions.conversation).toBe(
				projection.revisions.conversation + 1,
			);
		} finally {
			await runtime.close();
		}
	});
});
