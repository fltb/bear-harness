import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("moves legacy webdev Pi auth into the encrypted provider table", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "bear-legacy-web-auth-"));
	try {
		mkdirSync(join(dataDir, "companion-runtime"), { recursive: true });
		mkdirSync(join(dataDir, "storage"), { recursive: true });
		const credential = {
			type: "oauth",
			access: "secret-access",
			refresh: "secret-refresh",
			expires: Date.now() + 60_000,
		};
		writeFileSync(
			join(dataDir, "companion-runtime", "auth.json"),
			JSON.stringify({ "openai-codex": credential }),
		);
		const database = new DatabaseSync(join(dataDir, "storage", "canon.db"));
		database.exec(`
			CREATE TABLE provider_accounts (
				id TEXT PRIMARY KEY,
				provider_id TEXT NOT NULL,
				credential_blob BLOB,
				credential_status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		database.close();

		execFileSync(
			process.execPath,
			[join(import.meta.dirname, "migrate-legacy-web-auth.mjs"), dataDir],
			{ stdio: "pipe" },
		);

		assert.equal(existsSync(join(dataDir, "companion-runtime", "auth.json")), false);
		assert.equal(existsSync(join(dataDir, "companion-runtime", "auth.json.migrated")), true);
		const migrated = new DatabaseSync(join(dataDir, "storage", "canon.db"));
		const row = migrated
			.prepare("SELECT credential_blob, credential_status FROM provider_accounts WHERE id = ?")
			.get("openai-codex");
		migrated.close();
		assert.equal(row.credential_status, "weak_storage");
		assert.deepEqual(
			decrypt(readFileSync(join(dataDir, "security", "web-vault.key")), row.credential_blob),
			{
				piCredential: credential,
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("copies an encrypted login from the legacy database without exposing it", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "bear-copy-web-login-"));
	try {
		mkdirSync(join(dataDir, "security"), { recursive: true });
		mkdirSync(join(dataDir, "storage"), { recursive: true });
		const key = Buffer.alloc(32, 7);
		writeFileSync(join(dataDir, "security", "web-vault.key"), key);
		const payload = { piCredential: { type: "api_key", key: "secret-key" } };
		const blob = encrypt(key, JSON.stringify(payload));
		const legacyPath = join(dataDir, "legacy.db");
		for (const path of [legacyPath, join(dataDir, "storage", "canon.db")]) {
			const database = new DatabaseSync(path);
			database.exec(`
				CREATE TABLE provider_accounts (
					id TEXT PRIMARY KEY,
					provider_id TEXT NOT NULL,
					credential_blob BLOB,
					credential_status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			if (path === legacyPath)
				database
					.prepare(
						"INSERT INTO provider_accounts VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
					)
					.run("openai", "openai", blob, "weak_storage");
			database.close();
		}

		execFileSync(
			process.execPath,
			[join(import.meta.dirname, "copy-legacy-web-login.mjs"), legacyPath, dataDir],
			{ stdio: "pipe" },
		);
		const target = new DatabaseSync(join(dataDir, "storage", "canon.db"));
		const row = target
			.prepare("SELECT credential_blob FROM provider_accounts WHERE id = 'openai'")
			.get();
		target.close();
		assert.deepEqual(decrypt(key, row.credential_blob), payload);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

function decrypt(key, blob) {
	assert.equal(blob[0], 1);
	const iv = blob.subarray(1, 13);
	const tag = blob.subarray(13, 29);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return JSON.parse(
		Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8"),
	);
}

function encrypt(key, plaintext) {
	const iv = Buffer.alloc(12, 3);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}
