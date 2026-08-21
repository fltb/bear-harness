// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { describe, expect, it, vi } from "vitest";
import { CredentialStore, type CredentialVault } from "../src/providers/credential-store.js";

const BLOB_PREFIX = "vault-v1:";

function makeVault(overrides: Partial<CredentialVault> = {}): CredentialVault {
	return {
		securityLevel: "os",
		isEncryptionAvailable: () => true,
		encryptString: (plaintext) =>
			Buffer.from(`${BLOB_PREFIX}${Buffer.from(plaintext, "utf8").toString("base64")}`, "utf8"),
		decryptString: (blob) =>
			Buffer.from(blob.toString("utf8").slice(BLOB_PREFIX.length), "base64").toString("utf8"),
		...overrides,
	};
}

function createDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE provider_accounts (
			id TEXT PRIMARY KEY,
			provider_id TEXT NOT NULL,
			credential_blob BLOB,
			credential_status TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL
		)
	`);
	return db;
}

function storedBlob(
	db: DatabaseSync,
	providerId: string,
): { credential_blob: Buffer | null; credential_status: string } {
	return db
		.prepare("SELECT credential_blob, credential_status FROM provider_accounts WHERE id = ?")
		.get(providerId) as { credential_blob: Buffer | null; credential_status: string };
}

describe("CredentialStore security policy", () => {
	it.each([
		[
			"unavailable safeStorage",
			makeVault({ isEncryptionAvailable: () => false, securityLevel: "session" }),
		],
		["Electron basic_text", makeVault({ securityLevel: "session" })],
		["explicit sessionOnly", makeVault()],
	] as const)("keeps %s credentials in memory and writes no blob", async (name, vault) => {
		const db = createDb();
		const store = new CredentialStore(drizzle({ client: db }), vault);
		const sessionOnly = name === "explicit sessionOnly";

		expect(
			await store.set(
				"provider-a",
				{ apiKey: "secret" },
				sessionOnly ? { sessionOnly } : undefined,
			),
		).toBe("session_only");
		expect(await store.get("provider-a")).toMatchObject({
			providerId: "provider-a",
			apiKey: "secret",
			status: "session_only",
		});
		expect(storedBlob(db, "provider-a")).toEqual({
			credential_blob: null,
			credential_status: "session_only",
		});
		db.close();
	});

	it("persists encrypted credentials with strong OS storage and decrypts after restart", async () => {
		const db = createDb();
		const vault = makeVault({ securityLevel: "os" });
		const first = new CredentialStore(drizzle({ client: db }), vault);

		expect(await first.set("provider-os", { apiKey: "os-secret" })).toBe("stored");
		const row = storedBlob(db, "provider-os");
		expect(row.credential_status).toBe("stored");
		expect(row.credential_blob?.toString("utf8")).not.toContain("os-secret");

		const restarted = new CredentialStore(drizzle({ client: db }), vault);
		expect(await restarted.get("provider-os")).toMatchObject({
			apiKey: "os-secret",
			status: "stored",
		});
		db.close();
	});

	it("uses weak_storage only for an encrypted machine-local vault and survives restart", async () => {
		const db = createDb();
		const vault = makeVault({ securityLevel: "machine" });
		const first = new CredentialStore(drizzle({ client: db }), vault);

		expect(await first.set("provider-machine", { apiKey: "machine-secret" })).toBe("weak_storage");
		const row = storedBlob(db, "provider-machine");
		expect(row.credential_status).toBe("weak_storage");
		expect(row.credential_blob?.toString("utf8")).not.toContain("machine-secret");

		const restarted = new CredentialStore(drizzle({ client: db }), vault);
		expect(await restarted.get("provider-machine")).toMatchObject({
			apiKey: "machine-secret",
			status: "weak_storage",
		});
		db.close();
	});

	it("does not call encryption when the vault reports unavailable", async () => {
		const db = createDb();
		const encryptString = vi.fn(() => Buffer.from("must-not-be-written"));
		const store = new CredentialStore(
			drizzle({ client: db }),
			makeVault({ isEncryptionAvailable: () => false, securityLevel: "session", encryptString }),
		);

		await store.set("provider-a", { apiKey: "secret" });
		expect(encryptString).not.toHaveBeenCalled();
		expect(storedBlob(db, "provider-a").credential_blob).toBeNull();
		db.close();
	});

	it("keeps an available session vault memory-only", async () => {
		const db = createDb();
		const encryptString = vi.fn(() => Buffer.from("must-not-be-written"));
		const vault = makeVault({ securityLevel: "session", encryptString });
		const first = new CredentialStore(drizzle({ client: db }), vault);

		expect(await first.set("provider-session", { apiKey: "session-secret" })).toBe("session_only");
		expect(encryptString).not.toHaveBeenCalled();
		expect(storedBlob(db, "provider-session")).toEqual({
			credential_blob: null,
			credential_status: "session_only",
		});
		expect(await first.get("provider-session")).toMatchObject({
			apiKey: "session-secret",
			status: "session_only",
		});

		const restarted = new CredentialStore(drizzle({ client: db }), vault);
		expect(await restarted.get("provider-session")).toMatchObject({
			providerId: "provider-session",
			status: "session_only",
		});
		expect((await restarted.get("provider-session"))?.apiKey).toBeUndefined();
		db.close();
	});

	it("clears a legacy blob instead of reading it when encryption is unavailable", async () => {
		const db = createDb();
		db.prepare(
			"INSERT INTO provider_accounts (id, provider_id, credential_blob, credential_status, updated_at) VALUES (?, ?, ?, ?, ?)",
		).run(
			"legacy",
			"legacy",
			Buffer.from(JSON.stringify({ apiKey: "legacy-secret" })),
			"weak_storage",
			"now",
		);
		const store = new CredentialStore(
			drizzle({ client: db }),
			makeVault({ isEncryptionAvailable: () => false, securityLevel: "session" }),
		);

		expect(await store.get("legacy")).toMatchObject({
			providerId: "legacy",
			status: "unavailable",
		});
		expect(storedBlob(db, "legacy")).toEqual({
			credential_blob: null,
			credential_status: "unavailable",
		});
		db.close();
	});

	it("does not restore a session-only secret after restart", async () => {
		const db = createDb();
		const vault = makeVault();
		const first = new CredentialStore(drizzle({ client: db }), vault);
		await first.set("provider-session", { apiKey: "session-secret" }, { sessionOnly: true });

		const restarted = new CredentialStore(drizzle({ client: db }), vault);
		expect(await restarted.get("provider-session")).toMatchObject({
			providerId: "provider-session",
			status: "session_only",
		});
		expect((await restarted.get("provider-session"))?.apiKey).toBeUndefined();
		db.close();
	});
});
