// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import { PiSessionStore } from "../src/companion/pi-session-store.js";
import { type CredentialVault, createHostRuntime, type HostRuntime } from "../src/index.js";

const roots: string[] = [];
const runtimes: HostRuntime[] = [];
const silentLogger = { debug: () => undefined, warn: () => undefined };
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const vault: CredentialVault = {
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

function makeRuntime() {
	const dataDir = mkdtempSync(join(tmpdir(), "bear-ownership-"));
	roots.push(dataDir);
	const runtime = createHostRuntime({
		dataDir,
		characterRoot,
		productConfig,
		credentialVault: vault,
		logger: silentLogger,
	});
	runtimes.push(runtime);
	return runtime;
}

function makeRuntimeAt(dataDir: string) {
	const runtime = createHostRuntime({
		dataDir,
		characterRoot,
		productConfig,
		credentialVault: vault,
		logger: silentLogger,
	});
	runtimes.push(runtime);
	return runtime;
}

async function data(runtime: HostRuntime, channel: string, params: unknown): Promise<unknown> {
	const response = await runtime.dispatch(channel, params);
	if (!response.ok) throw new Error(response.error.reason);
	return response.data;
}

function sessionFor(dataDir: string, conversationId: string): PiSessionStore {
	const db = new DatabaseSync(join(dataDir, "storage", "canon.db"), { readOnly: true });
	try {
		const row = db
			.prepare("SELECT session_file_path FROM conversation_sessions WHERE conversation_id = ?")
			.get(conversationId) as { session_file_path?: string } | undefined;
		if (!row?.session_file_path) throw new Error("missing Pi session metadata");
		return PiSessionStore.open({
			sessionDir: join(dataDir, "sessions"),
			sessionFile: row.session_file_path,
		});
	} finally {
		db.close();
	}
}

function addCanonicalAssistant(dataDir: string, conversationId: string): string {
	const db = new DatabaseSync(join(dataDir, "storage", "canon.db"));
	try {
		const branch = db
			.prepare(
				"SELECT id FROM branches WHERE conversation_id = ? AND adopted = 1 ORDER BY rowid DESC LIMIT 1",
			)
			.get(conversationId) as { id?: string } | undefined;
		if (!branch?.id) throw new Error("missing adopted branch");
		const messageId = `${conversationId}-assistant`;
		const versionId = `${messageId}-v1`;
		db.prepare(
			"INSERT INTO messages (id, conversation_id, branch_id, role) VALUES (?, ?, ?, 'assistant')",
		).run(messageId, conversationId, branch.id);
		db.prepare(
			"INSERT INTO message_versions (id, message_id, content, adopted) VALUES (?, ?, 'projected assistant', 1)",
		).run(versionId, messageId);
		return messageId;
	} finally {
		db.close();
	}
}

describe("Host composition enforces ownership before mutation", () => {
	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.close();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("rejects message mutations that reference a foreign conversation or message", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const first = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		const second = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		const firstSent = (await data(runtime, "message.send:v1", {
			conversationId: first.id,
			text: "first",
		})) as { messageId: string; versionId: string };
		const secondSent = (await data(runtime, "message.send:v1", {
			conversationId: second.id,
			text: "second",
		})) as { messageId: string; versionId: string };

		// Unknown conversation is rejected before any mutation.
		await expect(
			runtime.dispatch("message.send:v1", { conversationId: "missing-conversation", text: "x" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });

		// A message from another conversation is not owned by this conversation.
		await expect(
			runtime.dispatch("message.edit:v1", {
				conversationId: first.id,
				messageId: secondSent.messageId,
				text: "forged",
				isUserMessage: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });

		// A version from another conversation/message is not switchable here.
		await expect(
			runtime.dispatch("message.switchVersion:v1", {
				conversationId: first.id,
				messageId: firstSent.messageId,
				versionId: secondSent.versionId,
			}),
		).resolves.toEqual({
			ok: false,
			error: { kind: "not_found", reason: "message_version_not_found" },
		});

		// A version id that does not exist at all is rejected.
		await expect(
			runtime.dispatch("message.switchVersion:v1", {
				conversationId: first.id,
				messageId: firstSent.messageId,
				versionId: "missing-version",
			}),
		).resolves.toEqual({
			ok: false,
			error: { kind: "not_found", reason: "message_version_not_found" },
		});

		// Same-conversation operations still succeed.
		await expect(
			runtime.dispatch("message.switchVersion:v1", {
				conversationId: first.id,
				messageId: firstSent.messageId,
				versionId: firstSent.versionId,
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it("accepts current canonical Pi projections, rejects foreign entries, and conflicts on stale branches", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-ownership-pi-"));
		roots.push(dataDir);
		const seed = createHostRuntime({
			dataDir,
			characterRoot,
			productConfig,
			credentialVault: vault,
			logger: silentLogger,
		});
		await seed.start();
		const first = (await data(seed, "conversation.create:v1", {})) as { id: string };
		const second = (await data(seed, "conversation.create:v1", {})) as { id: string };
		await seed.close();

		const firstSession = sessionFor(dataDir, first.id);
		const secondSession = sessionFor(dataDir, second.id);
		firstSession.appendUserMessage("projected user");
		const stalePiAssistant = firstSession.appendSyntheticAssistant("projected assistant");
		const foreign = secondSession.appendUserMessage("foreign entry");
		const canonicalAssistant = addCanonicalAssistant(dataDir, first.id);

		const runtime = makeRuntimeAt(dataDir);
		await runtime.start();

		// A current Pi projection supports version switching and edits by
		// resolving to its canonical Host message.
		await expect(
			runtime.dispatch("message.switchVersion:v1", {
				conversationId: first.id,
				messageId: canonicalAssistant,
				versionId: `${canonicalAssistant}-v1`,
			}),
		).resolves.toMatchObject({ ok: true });
		await expect(
			runtime.dispatch("message.edit:v1", {
				conversationId: first.id,
				messageId: canonicalAssistant,
				text: "edited projection",
				isUserMessage: false,
			}),
		).resolves.toMatchObject({ ok: true });
		// The edit forked the Pi tree, so the pre-edit assistant is now stale.
		await expect(
			runtime.dispatch("message.branch:v1", {
				conversationId: first.id,
				messageId: stalePiAssistant,
			}),
		).resolves.toEqual({
			ok: false,
			error: { kind: "conflict", reason: "message_not_current_branch" },
		});
		// An entry in another conversation's Pi session is foreign.
		await expect(
			runtime.dispatch("message.edit:v1", {
				conversationId: first.id,
				messageId: foreign,
				text: "forged",
				isUserMessage: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
	});
	it("dismisses only media declared by the active character", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };

		await expect(
			runtime.dispatch("roleplay.dismissMedia:v1", {
				conversationId: conversation.id,
				mediaId: "damaged_signal_live",
			}),
		).resolves.toMatchObject({ ok: true, data: {} });
		await expect(
			runtime.dispatch("roleplay.dismissMedia:v1", {
				conversationId: conversation.id,
				mediaId: "missing_media",
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "not_found", reason: "roleplay_media_not_found" },
		});

		const response = (await data(runtime, "events.subscribe:v1", { afterSeq: 0 })) as {
			events: Array<{ kind: string; payload: unknown }>;
		};
		expect(response.events).toContainEqual(
			expect.objectContaining({
				kind: "roleplay.media_dismissed",
				payload: { conversationId: conversation.id, mediaId: "damaged_signal_live" },
			}),
		);
		expect(response.events).not.toContainEqual(
			expect.objectContaining({
				kind: "roleplay.media_dismissed",
				payload: { conversationId: conversation.id, mediaId: "missing_media" },
			}),
		);
	});

	it("rejects run, commission and artifact operations for unknown IDs", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		await data(runtime, "message.send:v1", { conversationId: conversation.id, text: "hello" });

		await expect(
			runtime.dispatch("run.cancel:v1", { runId: "missing-run" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("run.steer:v1", { runId: "missing-run", instruction: "stop" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("commission.reject:v1", { commissionId: "missing-commission" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("artifact.read:v1", { artifactId: "missing-artifact" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("artifact.url:v1", { artifactId: "missing-artifact" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
	});
});
