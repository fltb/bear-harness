// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const safeStorage = vi.hoisted(() => ({
	isEncryptionAvailable: vi.fn<() => boolean>(),
	encryptString: vi.fn<(plaintext: string) => Buffer>(),
	decryptString: vi.fn<(blob: Buffer) => string>(),
}));

vi.mock("electron", () => ({ safeStorage }));

import { CredentialStore } from "../src/main/providers/credential-store.js";

describe("CredentialStore keychain failure", () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

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
		safeStorage.isEncryptionAvailable.mockReturnValue(true);
		safeStorage.encryptString.mockImplementation(() => {
			throw new Error("keychain unavailable");
		});

		const store = new CredentialStore(db);
		expect(await store.set("provider-a", { apiKey: "secret" })).toBe("session_only");
		expect(await store.get("provider-a")).toMatchObject({
			providerId: "provider-a",
			apiKey: "secret",
			status: "session_only",
		});
		expect(
			db.prepare("SELECT credential_blob, credential_status FROM provider_accounts WHERE id = ?")
			.get("provider-a"),
		).toEqual({ credential_blob: null, credential_status: "session_only" });
		db.close();
	});
});
