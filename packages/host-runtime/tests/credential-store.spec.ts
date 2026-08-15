// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CredentialStore, type CredentialVault } from "../src/providers/credential-store.js";

function makeVault(overrides: Partial<CredentialVault> = {}): CredentialVault {
	return {
		isEncryptionAvailable: () => true,
		encryptString: (plaintext) => Buffer.from(plaintext, "utf8"),
		decryptString: (blob) => blob.toString("utf8"),
		...overrides,
	};
}

describe("CredentialStore keychain failure", () => {
	it("keeps a credential in memory when Electron encryption fails", async () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE provider_accounts (
				id TEXT PRIMARY KEY,
				provider_id TEXT NOT NULL,
				credential_blob BLOB,
				credential_status TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		const vault = makeVault({
			encryptString: () => {
				throw new Error("keychain unavailable");
			},
		});
		const store = new CredentialStore(db, vault);
		expect(await store.set("provider-a", { apiKey: "secret" })).toBe("session_only");
		expect(await store.get("provider-a")).toMatchObject({
			providerId: "provider-a",
			apiKey: "secret",
			status: "session_only",
		});
		expect(
			db
				.prepare("SELECT credential_blob, credential_status FROM provider_accounts WHERE id = ?")
				.get("provider-a"),
		).toEqual({ credential_blob: null, credential_status: "session_only" });
		db.close();
	});
});
