#!/usr/bin/env node

import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const sourceArgument = process.argv[2];
const targetArgument = process.argv[3];
if (!sourceArgument || !targetArgument) {
	throw new Error(
		"usage: node scripts/copy-legacy-web-login.mjs <legacy-canon.db> <new-webdev-data-dir>",
	);
}

const sourcePath = absolute(sourceArgument);
const targetRoot = absolute(targetArgument);
const targetPath = join(targetRoot, "storage", "canon.db");
const keyPath = join(targetRoot, "security", "web-vault.key");
for (const path of [sourcePath, targetPath, keyPath]) {
	if (!existsSync(path)) throw new Error(`required migration input is missing: ${path}`);
}

const source = new DatabaseSync(sourcePath, { readOnly: true });
const rows = source
	.prepare(`
		SELECT id, provider_id, credential_blob, credential_status
		FROM provider_accounts
		WHERE credential_blob IS NOT NULL
			AND credential_status IN ('stored', 'weak_storage')
	`)
	.all();
source.close();
if (rows.length === 0) throw new Error("legacy database contains no persistent provider login");

const key = readFileSync(keyPath);
if (key.length !== 32) throw new Error("invalid target web vault key");
for (const row of rows) validateBlob(key, row.credential_blob);

const target = new DatabaseSync(targetPath);
target.function("bear_sync_changed", () => 0);
try {
	target.exec("BEGIN IMMEDIATE");
	try {
		const current = target.prepare("SELECT credential_blob FROM provider_accounts WHERE id = ?");
		const insert = target.prepare(`
			INSERT INTO provider_accounts(
				id, provider_id, credential_blob, credential_status, created_at, updated_at
			) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
			ON CONFLICT(id) DO UPDATE SET
				credential_blob = excluded.credential_blob,
				credential_status = excluded.credential_status,
				updated_at = excluded.updated_at
			WHERE provider_accounts.credential_blob IS NULL
		`);
		let copied = 0;
		for (const row of rows) {
			if (current.get(row.id)?.credential_blob) continue;
			insert.run(row.id, row.provider_id, row.credential_blob, row.credential_status);
			copied += 1;
		}
		target.exec("COMMIT");
		process.stdout.write(`Copied ${copied} provider login(s) into the new database.\n`);
	} catch (error) {
		target.exec("ROLLBACK");
		throw error;
	}
} finally {
	target.close();
}

function absolute(value) {
	return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function validateBlob(key, blob) {
	if (blob.length < 29 || blob[0] !== 1) throw new Error("legacy login is not a webdev credential");
	const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
	decipher.setAuthTag(blob.subarray(13, 29));
	const payload = JSON.parse(
		Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8"),
	);
	if (!payload || typeof payload !== "object" || !("piCredential" in payload)) {
		throw new Error("legacy login payload is invalid");
	}
}
