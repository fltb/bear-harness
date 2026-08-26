// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { describe, expect, it, vi } from "vitest";
import {
	CredentialStore,
	type CredentialVault,
	EncryptedPiCredentialStore,
} from "../src/providers/credential-store.js";

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

	it("keeps persisted credentials intact across temporary vault and decrypt failures", async () => {
		const db = createDb();
		let available = true;
		let decryptFails = false;
		const vault = makeVault({
			isEncryptionAvailable: () => available,
			decryptString: (blob) => {
				if (decryptFails) throw new Error("vault decrypt failed");
				return Buffer.from(blob.toString("utf8").slice(BLOB_PREFIX.length), "base64").toString(
					"utf8",
				);
			},
		});
		const store = new CredentialStore(drizzle({ client: db }), vault);

		expect(await store.set("provider-os", { apiKey: "original-secret" })).toBe("stored");
		const persisted = storedBlob(db, "provider-os");
		const originalBlob = Buffer.from(persisted.credential_blob!);
		expect(persisted.credential_status).toBe("stored");

		available = false;
		expect(await store.list()).toEqual([{ providerId: "provider-os", status: "unavailable" }]);
		expect(await store.getStatus("provider-os")).toBe("unavailable");
		const unavailableCredential = await store.get("provider-os");
		expect(unavailableCredential).toMatchObject({
			providerId: "provider-os",
			status: "unavailable",
		});
		expect(unavailableCredential).not.toHaveProperty("apiKey");
		const unavailablePersisted = storedBlob(db, "provider-os");
		expect(unavailablePersisted.credential_status).toBe("stored");
		expect(Buffer.from(unavailablePersisted.credential_blob!)).toEqual(originalBlob);

		available = true;
		decryptFails = true;
		expect(await store.list()).toEqual([{ providerId: "provider-os", status: "stored" }]);
		expect(await store.getStatus("provider-os")).toBe("stored");
		const invalidCredential = await store.get("provider-os");
		expect(invalidCredential).toMatchObject({
			providerId: "provider-os",
			status: "invalid",
		});
		expect(invalidCredential).not.toHaveProperty("apiKey");
		const decryptFailedPersisted = storedBlob(db, "provider-os");
		expect(decryptFailedPersisted.credential_status).toBe("stored");
		expect(Buffer.from(decryptFailedPersisted.credential_blob!)).toEqual(originalBlob);

		decryptFails = false;
		expect(await store.get("provider-os")).toMatchObject({
			providerId: "provider-os",
			status: "stored",
			apiKey: "original-secret",
		});

		await store.remove("provider-os");
		expect(await store.get("provider-os")).toBeNull();
		expect(await store.getStatus("provider-os")).toBe("missing");
		expect(await store.list()).toEqual([]);
		expect(
			db.prepare("SELECT id FROM provider_accounts WHERE id = ?").get("provider-os"),
		).toBeUndefined();
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

	it("persists opaque Pi OAuth credentials through the encrypted vault", async () => {
		const db = createDb();
		const vault = makeVault();
		const first = new EncryptedPiCredentialStore(
			new CredentialStore(drizzle({ client: db }), vault),
		);
		const credential = {
			type: "oauth" as const,
			access: "oauth-access-secret",
			refresh: "oauth-refresh-secret",
			expires: Date.now() + 60_000,
		};
		await first.modify("openai-codex", async () => credential);
		const row = storedBlob(db, "openai-codex");
		expect(row.credential_status).toBe("stored");
		expect(row.credential_blob?.toString("utf8")).not.toContain("oauth-access-secret");
		expect(row.credential_blob?.toString("utf8")).not.toContain("oauth-refresh-secret");

		const restarted = new EncryptedPiCredentialStore(
			new CredentialStore(drizzle({ client: db }), vault),
		);
		await expect(restarted.read("openai-codex")).resolves.toEqual(credential);
		await expect(restarted.list()).resolves.toEqual([
			{ providerId: "openai-codex", type: "oauth" },
		]);
		db.close();
	});

	it("serializes Pi credential refresh mutations per provider", async () => {
		const db = createDb();
		const adapter = new EncryptedPiCredentialStore(
			new CredentialStore(drizzle({ client: db }), makeVault()),
		);
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstStarted = false;
		let secondStarted = false;
		const first = adapter.modify("openai-codex", async () => {
			firstStarted = true;
			await firstGate;
			return {
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60_000,
			};
		});
		await vi.waitFor(() => expect(firstStarted).toBe(true));
		const second = adapter.modify("openai-codex", async (current) => {
			secondStarted = true;
			expect(current).toMatchObject({ access: "access-1", refresh: "refresh-1" });
			return {
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 120_000,
			};
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(secondStarted).toBe(false);
		releaseFirst();
		await Promise.all([first, second]);
		await expect(adapter.read("openai-codex")).resolves.toMatchObject({
			access: "access-2",
			refresh: "refresh-2",
		});
		db.close();
	});
});
