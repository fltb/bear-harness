import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CharacterLoader } from "../packages/host-runtime/dist/companion/character-loader.js";
import {
	COMPANION_SCHEMA_SQL,
	Database,
	SYSTEM_SCHEMA_SQL,
} from "../packages/host-runtime/dist/storage/database.js";
import {
	convertAuditRows,
	convertNamespace,
	convertState,
	migrateInstallation,
	relocateSessionHeaders,
} from "./migrate-installation.mjs";

const character = new CharacterLoader(resolve("config/characters")).load("jizhou");
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("keeps relationship and old progress as text while removing obsolete controls", () => {
	const state = (scope, value) =>
		JSON.parse(
			convertState({ domain: "character", scope, state_json: JSON.stringify(value) }, character),
		);
	const global = state("global", {
		relationship: { affinity: 17, summary: "共同经历" },
		continuity: { stage: 3, response: "原来记录" },
	});
	assert.equal(global.relationship.affinity, 17);
	assert(global.relationship.summary.includes("原来记录"));
	const scene = state("conversation", {
		story: { active: true, chapter: 2, summary: "旧情节", user_choices: "保留的选择" },
	});
	assert.equal(scene.story.active, false);
	assert.equal(scene.story.chapter, undefined);
	assert.equal(scene.story.user_choices, "保留的选择");
	assert(scene.story.summary.includes("第 2 章"));
	assert.throws(() => state("global", { unrecognized: true }));
	const display = JSON.parse(
		convertState(
			{
				domain: "display",
				state_json: JSON.stringify({
					sceneId: "study",
					expressionId: "calm",
					surfaces: { choices: "old-command" },
				}),
			},
			character,
		),
	);
	assert.deepEqual(display, { sceneId: "study", expressionId: "calm" });
});

test("changes only exact memory namespace references and preserves content", () => {
	const value = {
		sessionKey: "memory:v1:installation:user:role",
		content: "literal memory:v1:installation:user:role",
		states: { "memory:v1:installation:user:role": { cursor: 9 } },
	};
	const result = convertNamespace(value, value.sessionKey, "memory:installation:user:role");
	assert.equal(result.sessionKey, "memory:installation:user:role");
	assert.equal(result.content, value.content);
	assert.deepEqual(result.states, { "memory:installation:user:role": { cursor: 9 } });
});

test("validates original audit hashes before producing a versioned chain", () => {
	const row = {
		id: "a",
		seq: 1,
		kind: "config",
		action: "changed",
		detail: "preserved",
		createdAt: "2026-01-01",
		prevHash: sha(""),
	};
	row.hash = sha(
		`${row.seq}|${row.kind}|${row.action}|${row.detail}|${row.createdAt}|${row.prevHash}`,
	);
	const [converted] = convertAuditRows([row]);
	assert.equal(converted.detail, row.detail);
	assert.equal(
		converted.hash,
		sha(`1|${row.seq}|${row.kind}|${row.action}|${row.detail}|${row.createdAt}|${row.prevHash}`),
	);
	assert.throws(() => convertAuditRows([{ ...row, detail: "tampered" }]));
});

test("relocates only the Pi header and retains native entry bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "bear-migration-test-"));
	try {
		const dir = join(root, "companions/role/sessions");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "2026-01-01T00-00-00-000Z_session-a.jsonl");
		const body =
			'\n{"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"unchanged"}}\n';
		writeFileSync(
			file,
			JSON.stringify({ type: "session", version: 3, id: "session-a", cwd: "/old" }) + body,
		);
		relocateSessionHeaders(root, "/new");
		const updated = readFileSync(file, "utf8");
		assert.equal(updated.slice(updated.indexOf("\n")), body);
		assert.equal(JSON.parse(updated.split("\n")[0]).cwd, "/new/companions/role");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rebuilds legacy databases without losing drafts, credentials, or Catalog ownership", () => {
	const root = mkdtempSync(join(tmpdir(), "bear-whole-migration-"));
	const source = join(root, "source");
	const destination = join(root, "converted");
	try {
		mkdirSync(join(source, "characters/jizhou"), { recursive: true });
		writeFileSync(join(source, "characters/jizhou/character.yaml"), "id: jizhou\n");
		mkdirSync(join(source, "companions/jizhou/sessions"), { recursive: true });
		const system = new Database(join(source, "system"), { fileName: "settings.db" });
		system.initialize(SYSTEM_SCHEMA_SQL);
		system.connection.exec(
			"ALTER TABLE app_settings ADD COLUMN first_run_stage TEXT DEFAULT 'role'; ALTER TABLE executor_profiles ADD COLUMN capability_json TEXT DEFAULT '{}'; PRAGMA user_version=0",
		);
		system.connection.exec(
			"INSERT INTO character_drafts(id) VALUES('draft-a'); INSERT INTO character_draft_revisions(draft_id,revision,files_json) VALUES('draft-a',1,'{}')",
		);
		system.connection
			.prepare(
				"INSERT INTO provider_accounts(id,provider_id,credential_blob) VALUES('provider','provider',?)",
			)
			.run(Buffer.from([4, 8, 15, 16]));
		system.close();
		const characterDb = new Database(join(source, "companions/jizhou"), { fileName: "runtime.db" });
		characterDb.initialize(COMPANION_SCHEMA_SQL);
		characterDb.connection.exec(
			"INSERT INTO runtime_identity(id,companion_id) VALUES(1,'jizhou'); INSERT INTO conversations(id,companion_id) VALUES('session-a','jizhou'); PRAGMA user_version=0",
		);
		characterDb.close();
		const receipt = migrateInstallation(source, destination, resolve("config/characters"));
		assert.equal(receipt.system.character_drafts, 1);
		assert.equal(receipt.system.character_draft_revisions, 1);
		assert.equal(receipt.characters.jizhou.counts.conversations, 1);
		const check = new Database(join(destination, "system"), { fileName: "settings.db" });
		try {
			assert.equal(check.connection.prepare("PRAGMA user_version").get().user_version, 1);
			assert.deepEqual(
				Buffer.from(
					check.connection.prepare("SELECT credential_blob AS blob FROM provider_accounts").get()
						.blob,
				),
				Buffer.from([4, 8, 15, 16]),
			);
			assert.deepEqual(check.connection.prepare("PRAGMA foreign_key_check").all(), []);
		} finally {
			check.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
