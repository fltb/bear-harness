/**
 * CredentialStore — wraps Electron safeStorage with a pi-ai-compatible
 * interface for provider API keys and OAuth tokens.
 *
 * On macOS/Windows, safeStorage encrypts the BLOB before writing to the
 * `provider_accounts` table. On Linux, safeStorage may use `basic_text`
 * (libsecret) or fall back to weak storage; the UI shows the credential
 * status accordingly and never claims encryption.
 *
 * OAuth refresh tokens are managed per-provider via `modify()`; secrets
 * never enter the renderer, run manifest, evidence, or diagnostics.
 */

import { safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CredentialStatus =
	| "missing"
	| "session_only"
	| "stored"
	| "weak_storage"
	| "refreshing"
	| "invalid"
	| "unavailable";

export interface ProviderCredential {
	providerId: string;
	apiKey?: string;
	oauthToken?: string;
	refreshToken?: string;
	status: CredentialStatus;
	updatedAt: string;
}

export class CredentialStore {
	private db: DatabaseSync;
	private sessionKeys = new Map<string, string>();
	private encryptionAvailable: boolean;

	constructor(db: DatabaseSync) {
		this.db = db;
		this.encryptionAvailable = safeStorage.isEncryptionAvailable();
	}

	/** Store a credential for a provider. */
	async set(
		providerId: string,
		credential: { apiKey?: string; oauthToken?: string; refreshToken?: string },
		options?: { sessionOnly?: boolean },
	): Promise<CredentialStatus> {
		const id = providerId;
		const now = new Date().toISOString();

		if (options?.sessionOnly) {
			// Session-only: keep in memory, not in DB
			if (credential.apiKey) this.sessionKeys.set(providerId, credential.apiKey);
			const status: CredentialStatus = "session_only";
			this.db
				.prepare(
					"INSERT INTO provider_accounts (id, provider_id, credential_blob, credential_status, updated_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET credential_status = ?, updated_at = ?",
				)
				.run(id, providerId, status, now, status, now);
			return status;
		}

		// Persist with safeStorage encryption
		const plaintext = JSON.stringify(credential);
		let blob: Buffer | null = null;
		let status: CredentialStatus;

		if (this.encryptionAvailable) {
			blob = safeStorage.encryptString(plaintext);
			status = "stored";
		} else {
			// Linux fallback: store as plaintext BLOB with warning
			blob = Buffer.from(plaintext, "utf8");
			status = "weak_storage";
		}

		this.db
			.prepare(
				"INSERT INTO provider_accounts (id, provider_id, credential_blob, credential_status, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET credential_blob = ?, credential_status = ?, updated_at = ?",
			)
			.run(id, providerId, blob, status, now, blob, status, now);

		return status;
	}

	/** Retrieve a credential for a provider. */
	async get(providerId: string): Promise<ProviderCredential | null> {
		// Check session cache first
		const sessionKey = this.sessionKeys.get(providerId);
		if (sessionKey) {
			return {
				providerId,
				apiKey: sessionKey,
				status: "session_only",
				updatedAt: new Date().toISOString(),
			};
		}

		const row = this.db
			.prepare(
				"SELECT credential_blob, credential_status, updated_at FROM provider_accounts WHERE id = ?",
			)
			.get(providerId) as
			| { credential_blob: Buffer | null; credential_status: string; updated_at: string }
			| undefined;

		if (!row) return null;

		let credential: { apiKey?: string; oauthToken?: string; refreshToken?: string } = {};

		if (row.credential_blob) {
			try {
				const plaintext =
					row.credential_status === "stored" && this.encryptionAvailable
						? safeStorage.decryptString(row.credential_blob)
						: row.credential_blob.toString("utf8");
				credential = JSON.parse(plaintext);
			} catch {
				return {
					providerId,
					status: "invalid",
					updatedAt: row.updated_at,
				};
			}
		}

		return {
			providerId,
			apiKey: credential.apiKey,
			oauthToken: credential.oauthToken,
			refreshToken: credential.refreshToken,
			status: row.credential_status as CredentialStatus,
			updatedAt: row.updated_at,
		};
	}

	/** Remove a stored credential. */
	async remove(providerId: string): Promise<void> {
		this.sessionKeys.delete(providerId);
		this.db.prepare("DELETE FROM provider_accounts WHERE id = ?").run(providerId);
	}

	/** Get the credential status for a provider (without revealing the secret). */
	async getStatus(providerId: string): Promise<CredentialStatus> {
		if (this.sessionKeys.has(providerId)) return "session_only";
		const row = this.db
			.prepare("SELECT credential_status FROM provider_accounts WHERE id = ?")
			.get(providerId) as { credential_status: string } | undefined;
		return (row?.credential_status as CredentialStatus) ?? "missing";
	}

	/** List all provider credentials (without secrets). */
	async list(): Promise<Array<{ providerId: string; status: CredentialStatus }>> {
		const rows = this.db
			.prepare("SELECT id, credential_status FROM provider_accounts ORDER BY id")
			.all() as Array<{ id: string; credential_status: string }>;
		const result: Array<{ providerId: string; status: CredentialStatus }> = [];
		for (const row of rows) {
			result.push({
				providerId: row.id,
				status: (row.credential_status as CredentialStatus) ?? "missing",
			});
		}
		// Add session keys not in DB
		for (const [providerId] of this.sessionKeys) {
			if (!result.some((r) => r.providerId === providerId)) {
				result.push({ providerId, status: "session_only" });
			}
		}
		return result;
	}
}