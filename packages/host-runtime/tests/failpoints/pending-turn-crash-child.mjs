import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const READY_PREFIX = "PENDING_TURN_COMMITTED:";
const states = new Set(["accepted", "dispatched", "user_persisted"]);
const [databasePath, failpoint, fixturePath] = process.argv.slice(2);

if (!databasePath || !fixturePath || !failpoint || !states.has(failpoint)) {
	throw new Error(
		"usage: pending-turn-crash-child.mjs <database-path> <accepted|dispatched|user_persisted> <fixture-json>",
	);
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
for (const key of [
	"turnId",
	"conversationId",
	"framedText",
	"attachmentId",
	"attachmentSendNonce",
	"imageMimeType",
	"imageBase64",
]) {
	if (typeof fixture[key] !== "string" || fixture[key].length === 0) {
		throw new Error(`invalid pending-turn fixture field: ${key}`);
	}
}
if (failpoint === "user_persisted" && !fixture.piEntryId) {
	throw new Error("user_persisted requires a native Pi entry id");
}

const database = new DatabaseSync(databasePath);
// Crash fixture writes bypass Host dispatch; journal rows remain durable.
database.function("bear_sync_changed", () => null);
database.exec("PRAGMA foreign_keys = ON");
database.exec("PRAGMA busy_timeout = 5000");
database.exec("PRAGMA synchronous = FULL");
const timestamp = new Date().toISOString();

try {
	database.exec("BEGIN IMMEDIATE");
	database
		.prepare(`
			INSERT INTO pending_turns (
				id, conversation_id, framed_text, images_json,
				attachment_ids_json, attachment_send_nonce, state,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
		`)
		.run(
			fixture.turnId,
			fixture.conversationId,
			fixture.framedText,
			JSON.stringify([
				{
					attachmentId: fixture.attachmentId,
					mimeType: fixture.imageMimeType,
					data: fixture.imageBase64,
				},
			]),
			JSON.stringify([fixture.attachmentId]),
			fixture.attachmentSendNonce,
			timestamp,
			timestamp,
		);

	if (failpoint === "dispatched" || failpoint === "user_persisted") {
		database
			.prepare("UPDATE pending_turns SET state = 'dispatched', updated_at = ? WHERE id = ?")
			.run(timestamp, fixture.turnId);
	}
	if (failpoint === "user_persisted") {
		database
			.prepare(`
				UPDATE pending_turns
				SET state = 'user_persisted', pi_entry_id = ?, updated_at = ?
				WHERE id = ?
			`)
			.run(fixture.piEntryId, timestamp, fixture.turnId);
	}

	// The marker is deliberately emitted only after COMMIT. The parent treats
	// it as the acknowledgement boundary and immediately observes SIGKILL.
	database.exec("COMMIT");
} catch (error) {
	try {
		database.exec("ROLLBACK");
	} catch {
		// Preserve the original failure when SQLite already ended the transaction.
	}
	database.close();
	throw error;
}

process.stdout.write(`${READY_PREFIX}${failpoint}\n`, () => {
	process.kill(process.pid, "SIGKILL");
});
