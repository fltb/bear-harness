// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PendingTurnStore } from "../src/companion/pending-turn-store.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";

const roots: string[] = [];
const COMPANION_ID = "companion-1";
const CONVERSATION_ID = "conversation-1";
const OTHER_CONVERSATION_ID = "conversation-2";

function openFixture(root?: string): { database: Database; store: PendingTurnStore; root: string } {
	const directory = root ?? mkdtempSync(join(tmpdir(), "bear-pending-turns-"));
	if (!root) roots.push(directory);
	const database = new Database(join(directory, "database"));
	database.migrate(MIGRATIONS);
	if (!root) {
		database.connection.exec(`
			INSERT INTO companion_packages (id, name, version, hash, origin)
			VALUES ('package-1', 'Package', '1.0.0', 'hash', 'official');
			INSERT INTO companion_identity (id, package_id, name, self_canon)
			VALUES ('${COMPANION_ID}', 'package-1', 'Companion', '{}');
			INSERT INTO conversations (id, companion_id, title)
			VALUES
				('${CONVERSATION_ID}', '${COMPANION_ID}', 'One'),
				('${OTHER_CONVERSATION_ID}', '${COMPANION_ID}', 'Two');
		`);
	}
	return { database, store: new PendingTurnStore(database.orm), root: directory };
}

function caught(action: () => unknown): unknown {
	try {
		action();
		return undefined;
	} catch (error) {
		return error;
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PendingTurnStore", () => {
	it("durably reopens exact framed text, attachment binding, and image bytes", () => {
		const { database, store, root } = openFixture();
		const turnId = randomUUID();
		const nonce = randomUUID();
		const image = Buffer.from([0, 1, 2, 3, 254, 255]);
		database.connection
			.prepare(`
			INSERT INTO conversation_attachments
				(id, conversation_id, origin_entry_id, send_nonce, kind, name, total_bytes, file_count)
			VALUES (?, ?, NULL, ?, 'file', 'pixel.png', ?, 1)
		`)
			.run("attachment-1", CONVERSATION_ID, nonce, image.byteLength);
		const input = {
			id: turnId,
			conversationId: CONVERSATION_ID,
			framedText:
				"<host_context>\nattachment\n</host_context>\n\n<current_user_message>\nexact\n</current_user_message>",
			attachmentIds: ["attachment-1"],
			attachmentSendNonce: nonce,
			images: [{ attachmentId: "attachment-1", mimeType: "image/png", data: image }],
		} as const;
		const accepted = store.createAccepted(input);
		expect(accepted).toMatchObject({
			id: turnId,
			state: "accepted",
			attachmentIds: ["attachment-1"],
			attachmentSendNonce: nonce,
		});
		expect(accepted.images[0]?.data.equals(image)).toBe(true);
		expect(store.createAccepted(input)).toEqual(accepted);
		database.close();

		const reopened = openFixture(root);
		const replay = reopened.store.lookupReplay(CONVERSATION_ID, turnId);
		expect(replay?.framedText).toBe(input.framedText);
		expect(replay?.images).toHaveLength(1);
		expect(replay?.images[0]).toMatchObject({
			attachmentId: "attachment-1",
			mimeType: "image/png",
		});
		expect(replay?.images[0]?.data.equals(image)).toBe(true);
		expect(reopened.store.listIncomplete(CONVERSATION_ID).map((row) => row.id)).toEqual([turnId]);
		reopened.database.close();
	});

	it("enforces adjacent monotonic transitions and makes exact retries idempotent", () => {
		const { database, store } = openFixture();
		const id = randomUUID();
		store.createAccepted({ id, conversationId: CONVERSATION_ID, framedText: "hello" });
		expect(
			caught(() =>
				store.transition({
					id,
					conversationId: CONVERSATION_ID,
					to: "user_persisted",
					piEntryId: "entry-1",
				}),
			),
		).toMatchObject({ reason: "pending_turn_transition_illegal" });

		const dispatched = store.transition({ id, conversationId: CONVERSATION_ID, to: "dispatched" });
		expect(store.transition({ id, conversationId: CONVERSATION_ID, to: "dispatched" })).toEqual(
			dispatched,
		);
		const failed = store.recordError(CONVERSATION_ID, id, "dispatch interrupted");
		expect(store.listIncomplete(CONVERSATION_ID)[0]?.lastError).toBe("dispatch interrupted");
		expect(failed.state).toBe("dispatched");
		const persisted = store.transition({
			id,
			conversationId: CONVERSATION_ID,
			to: "user_persisted",
			piEntryId: "entry-1",
		});
		expect(persisted).toMatchObject({
			state: "user_persisted",
			piEntryId: "entry-1",
			lastError: null,
		});
		expect(
			store.transition({
				id,
				conversationId: CONVERSATION_ID,
				to: "user_persisted",
				piEntryId: "entry-1",
			}),
		).toEqual(persisted);
		expect(
			caught(() =>
				store.transition({
					id,
					conversationId: CONVERSATION_ID,
					to: "user_persisted",
					piEntryId: "other-entry",
				}),
			),
		).toMatchObject({ reason: "pending_turn_pi_entry_conflict" });
		const completed = store.transition({ id, conversationId: CONVERSATION_ID, to: "completed" });
		expect(completed).toMatchObject({ state: "completed", piEntryId: "entry-1" });
		expect(completed.completedAt).not.toBeNull();
		expect(store.listIncomplete(CONVERSATION_ID)).toEqual([]);
		expect(store.list({ conversationId: CONVERSATION_ID, includeCompleted: true })).toHaveLength(1);
		expect(store.deleteCompleted(CONVERSATION_ID, id)).toBe(true);
		expect(store.deleteCompleted(CONVERSATION_ID, id)).toBe(false);
		database.close();
	});

	it("rejects malformed, oversized, unbound, and corrupt JSON payloads", () => {
		const { database, store } = openFixture();
		expect(
			caught(() =>
				store.createAccepted({
					id: randomUUID(),
					conversationId: CONVERSATION_ID,
					framedText: "x".repeat(256 * 1024 + 1),
				}),
			),
		).toMatchObject({ reason: "pending_turn_text_invalid" });
		expect(
			caught(() =>
				store.createAccepted({
					id: randomUUID(),
					conversationId: CONVERSATION_ID,
					framedText: "image",
					images: [
						{ attachmentId: "attachment-absent", mimeType: "image/png", data: Buffer.from("x") },
					],
				}),
			),
		).toMatchObject({ reason: "pending_turn_image_attachment_unbound" });

		const id = randomUUID();
		store.createAccepted({ id, conversationId: CONVERSATION_ID, framedText: "valid first" });
		expect(
			caught(() =>
				store.createAccepted({
					id,
					conversationId: CONVERSATION_ID,
					framedText: "different retry",
				}),
			),
		).toMatchObject({ reason: "pending_turn_idempotency_conflict" });
		database.connection.exec("PRAGMA ignore_check_constraints = ON");
		database.connection
			.prepare("UPDATE pending_turns SET images_json = ? WHERE id = ?")
			.run("{malformed", id);
		expect(caught(() => store.get(CONVERSATION_ID, id))).toMatchObject({
			reason: "pending_turn_images_malformed",
		});
		database.close();
	});

	it("scopes ownership, cascades conversation deletion, and retains every incomplete row", () => {
		const { database, store } = openFixture();
		const id = randomUUID();
		store.createAccepted({ id, conversationId: CONVERSATION_ID, framedText: "keep me" });
		expect(store.get(OTHER_CONVERSATION_ID, id)).toBeUndefined();
		expect(caught(() => store.deleteCompleted(CONVERSATION_ID, id))).toMatchObject({
			reason: "pending_turn_incomplete_retained",
		});
		expect(store.get(CONVERSATION_ID, id)).toBeDefined();
		expect(store.pruneCompleted(new Date(Date.now() + 60_000).toISOString())).toBe(0);
		expect(store.get(CONVERSATION_ID, id)).toBeDefined();

		database.connection.prepare("DELETE FROM conversations WHERE id = ?").run(CONVERSATION_ID);
		expect(store.listIncomplete()).toEqual([]);
		const count = database.connection
			.prepare("SELECT COUNT(*) AS count FROM pending_turns")
			.get() as {
			count: number;
		};
		expect(count.count).toBe(0);
		database.close();
	});
});
