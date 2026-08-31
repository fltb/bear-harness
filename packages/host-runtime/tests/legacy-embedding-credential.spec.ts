// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CredentialStore,
	type CredentialVault,
	REMOTE_EMBEDDING_CREDENTIAL_ID,
} from "../src/providers/credential-store.js";
import { AppSettingsStore } from "../src/storage/app-settings-store.js";
import { SYSTEM_MIGRATIONS, SystemDatabase } from "../src/storage/database.js";

const roots: string[] = [];
const LEGACY_SECRET = "legacy-embedding-secret";

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function vault(securityLevel: "os" | "machine" | "session"): CredentialVault {
	return {
		securityLevel,
		isEncryptionAvailable: () => securityLevel !== "session",
		encryptString: (plaintext) =>
			Buffer.from(`vault:${Buffer.from(plaintext, "utf8").toString("base64")}`, "utf8"),
		decryptString: (blob) =>
			Buffer.from(blob.toString("utf8").slice("vault:".length), "base64").toString("utf8"),
	};
}

function fixture(securityLevel: "os" | "machine" | "session") {
	const root = mkdtempSync(join(tmpdir(), "bear-legacy-embedding-"));
	roots.push(root);
	const database = new SystemDatabase(join(root, "system", "settings.db"));
	database.migrate(SYSTEM_MIGRATIONS);
	database.connection.prepare("UPDATE app_settings SET memory_vector_service = ? WHERE id = 1").run(
		JSON.stringify({
			enabled: true,
			provider: "remote",
			baseUrl: "https://embedding.example/v1",
			apiKey: LEGACY_SECRET,
			model: "embedding-model",
			dimensions: 768,
		}),
	);
	return {
		database,
		settings: new AppSettingsStore(database.orm),
		credentials: new CredentialStore(database.orm, vault(securityLevel)),
	};
}

function rawSettings(database: SystemDatabase): string {
	return String(
		database.connection.prepare("SELECT memory_vector_service FROM app_settings WHERE id = 1").get()
			?.memory_vector_service,
	);
}

describe("legacy remote embedding credential migration", () => {
	it.each([
		["os", "stored"],
		["machine", "weak_storage"],
	] as const)(
		"imports into the %s vault before atomically scrubbing Settings",
		async (level, status) => {
			const { database, settings, credentials } = fixture(level);

			expect(await credentials.migrateLegacyRemoteEmbeddingCredential(settings)).toBe(status);
			expect(rawSettings(database)).not.toContain(LEGACY_SECRET);
			expect(rawSettings(database)).not.toContain("apiKey");
			expect(JSON.stringify(settings.load())).not.toContain(LEGACY_SECRET);

			const row = database.connection
				.prepare("SELECT credential_blob FROM provider_accounts WHERE id = ?")
				.get(REMOTE_EMBEDDING_CREDENTIAL_ID) as { credential_blob: Buffer };
			expect(row.credential_blob.toString("utf8")).not.toContain(LEGACY_SECRET);
			const restarted = new CredentialStore(database.orm, vault(level));
			expect(restarted.read(REMOTE_EMBEDDING_CREDENTIAL_ID)?.apiKey).toBe(LEGACY_SECRET);
			database.close();
		},
	);

	it("retains a session-only key in memory and leaves no plaintext row", async () => {
		const { database, settings, credentials } = fixture("session");

		expect(await credentials.migrateLegacyRemoteEmbeddingCredential(settings)).toBe("session_only");
		expect(credentials.read(REMOTE_EMBEDDING_CREDENTIAL_ID)).toMatchObject({
			apiKey: LEGACY_SECRET,
			status: "session_only",
		});
		expect(rawSettings(database)).not.toContain(LEGACY_SECRET);
		const row = database.connection
			.prepare("SELECT credential_blob, credential_status FROM provider_accounts WHERE id = ?")
			.get(REMOTE_EMBEDDING_CREDENTIAL_ID) as {
			credential_blob: Buffer | null;
			credential_status: string;
		};
		expect(row).toEqual({ credential_blob: null, credential_status: "session_only" });
		database.close();
	});

	it("preserves plaintext when import fails, then retries once without a dual read", async () => {
		const { database, settings, credentials } = fixture("os");
		let saveError: unknown;
		try {
			settings.save({ networkProxy: { mode: "direct" } });
		} catch (error) {
			saveError = error;
		}
		expect(saveError).toEqual({
			kind: "unavailable",
			reason: "legacy_embedding_credential_migration_required",
		});
		expect(rawSettings(database)).toContain(LEGACY_SECRET);

		const failedImport = vi
			.spyOn(credentials, "set")
			.mockRejectedValueOnce(new Error("vault unavailable"));

		await expect(credentials.migrateLegacyRemoteEmbeddingCredential(settings)).rejects.toThrow(
			"vault unavailable",
		);
		expect(rawSettings(database)).toContain(LEGACY_SECRET);

		failedImport.mockRestore();
		expect(await credentials.migrateLegacyRemoteEmbeddingCredential(settings)).toBe("stored");
		expect(rawSettings(database)).not.toContain(LEGACY_SECRET);
		const setAgain = vi.spyOn(credentials, "set");
		expect(await credentials.migrateLegacyRemoteEmbeddingCredential(settings)).toBeNull();
		expect(setAgain).not.toHaveBeenCalled();
		database.close();
	});
});
