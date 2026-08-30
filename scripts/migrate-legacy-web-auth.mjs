#!/usr/bin/env node

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const VERSION = 1;
const IV_BYTES = 12;
const dataDirArgument = process.argv[2];

if (!dataDirArgument) {
	throw new Error("usage: node scripts/migrate-legacy-web-auth.mjs <webdev-data-dir>");
}

const dataDir = isAbsolute(dataDirArgument)
	? dataDirArgument
	: resolve(process.cwd(), dataDirArgument);
const authPath = join(dataDir, "companion-runtime", "auth.json");
const databasePath = join(dataDir, "storage", "canon.db");

if (!existsSync(authPath)) throw new Error("legacy auth.json was not found");
if (!existsSync(databasePath))
	throw new Error("target canon.db was not found; start the new app once first");

const document = JSON.parse(readFileSync(authPath, "utf8"));
if (!isRecord(document)) throw new Error("legacy auth.json must contain a provider map");
const credentials = Object.entries(document);
if (credentials.length === 0) throw new Error("legacy auth.json contains no credentials");
for (const [providerId, credential] of credentials) {
	if (!providerId || !isCredential(credential))
		throw new Error("legacy auth.json contains invalid data");
}

const key = loadWebVaultKey(dataDir);
const database = new DatabaseSync(databasePath);
database.function("bear_sync_changed", () => 0);
try {
	const table = database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_accounts'")
		.get();
	if (!table) throw new Error("target database does not have provider_accounts");
	database.exec("BEGIN IMMEDIATE");
	try {
		const current = database.prepare("SELECT credential_blob FROM provider_accounts WHERE id = ?");
		const insert = database.prepare(`
			INSERT INTO provider_accounts(
				id, provider_id, credential_blob, credential_status, created_at, updated_at
			) VALUES (?, ?, ?, 'weak_storage', datetime('now'), datetime('now'))
			ON CONFLICT(id) DO UPDATE SET
				credential_blob = excluded.credential_blob,
				credential_status = excluded.credential_status,
				updated_at = excluded.updated_at
			WHERE provider_accounts.credential_blob IS NULL
		`);
		for (const [providerId, credential] of credentials) {
			if (current.get(providerId)?.credential_blob) continue;
			insert.run(
				providerId,
				providerId,
				encrypt(key, JSON.stringify({ piCredential: credential })),
			);
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
} finally {
	database.close();
}

renameSync(authPath, `${authPath}.migrated`);
process.stdout.write(
	`Migrated ${credentials.length} provider credential(s); legacy file renamed to auth.json.migrated.\n`,
);

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredential(value) {
	if (!isRecord(value)) return false;
	if (value.type === "api_key") return typeof value.key === "string" && value.key.length > 0;
	return (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		Number.isFinite(value.expires)
	);
}

function loadWebVaultKey(root) {
	const configured = process.env.BEAR_WEB_DEV_MASTER_KEY;
	if (configured) return createHash("sha256").update(configured, "utf8").digest();
	const securityDir = join(root, "security");
	const keyPath = join(securityDir, "web-vault.key");
	if (existsSync(keyPath)) {
		const key = readFileSync(keyPath);
		if (key.length !== 32) throw new Error("invalid web vault key");
		chmodSync(keyPath, 0o600);
		return key;
	}
	mkdirSync(securityDir, { recursive: true, mode: 0o700 });
	const key = randomBytes(32);
	writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
	return key;
}

function encrypt(key, plaintext) {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), encrypted]);
}
