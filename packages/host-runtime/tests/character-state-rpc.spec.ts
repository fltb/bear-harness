// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CredentialVault, createHostRuntime } from "../src/index.js";
import type { Database } from "../src/storage/database.js";
import { conversations } from "../src/storage/schema.js";

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

describe("character state RPC projection", () => {
	it("commits an intent, publishes an event, and exposes the result only through the next snapshot", async () => {
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
			const conversation = { id: randomUUID() };
			const database = Reflect.get(runtime, "db") as Database;
			database.orm
				.insert(conversations)
				.values({ id: conversation.id, companionId: productConfig.defaultCharacterId })
				.run();
			const before = (await data(runtime, "snapshot.get:v1", {})) as {
				companion: {
					byConversation: Record<
						string,
						{
							character: {
								document: { story: { undelivered_report: { user_interpretation: string[] } } };
								revisions: { conversation: number; global: number };
							};
						}
					>;
				};
			};
			const projection = before.companion.byConversation[conversation.id]?.character;
			if (!projection) throw new Error("missing initial character-state projection");
			expect(projection.document.story.undelivered_report.user_interpretation).toEqual([]);

			const receive = vi.fn();
			const stop = runtime.subscribeEvents(receive, 0);
			const response = await data(runtime, "companionState.patch:v1", {
				conversationId: conversation.id,
				expectedRevisions: projection.revisions,
				operations: [
					{
						op: "replace",
						path: "/story/undelivered_report/user_interpretation",
						value: ["两份记录都不足以确认最终接收者。"],
					},
				],
				dedupeKey: randomUUID(),
			});
			expect(response).toEqual({});
			expect(receive.mock.calls.map(([event]) => event.kind)).toContain(
				"companion.snapshot_changed",
			);
			stop();

			const after = (await data(runtime, "snapshot.get:v1", {})) as typeof before;
			expect(
				after.companion.byConversation[conversation.id]?.character.document.story.undelivered_report
					.user_interpretation,
			).toEqual(["两份记录都不足以确认最终接收者。"]);
			expect(
				after.companion.byConversation[conversation.id]?.character.revisions.conversation,
			).toBe(projection.revisions.conversation + 1);
		} finally {
			await runtime.close();
		}
	});
});
