/**
 * CredentialStore — persists provider API keys and OAuth tokens through an
 * injected platform vault.
 *
 * The vault abstracts the OS-backed encryption layer (Electron's safeStorage
 * in the desktop app). On macOS/Windows the vault encrypts the BLOB before
 * writing to the `provider_accounts` table. If the OS keychain is
 * unavailable, credentials remain in memory for this session; they are never
 * persisted in plaintext. Linux may explicitly use a weak-storage fallback
 * provided by the vault.
 *
 * OAuth refresh tokens are managed per-provider via `modify()`; secrets
 * never enter the renderer, run manifest, evidence, or diagnostics.
 */

import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { providerAccounts } from "../storage/schema.js";

/**
 * Platform credential encryption boundary. The desktop app injects an
 * Electron `safeStorage`-backed implementation; tests and other hosts may
 * provide an in-memory vault. `encryptString`/`decryptString` must round-trip
 * when `isEncryptionAvailable()` is true.
 */
export interface CredentialVault {
	/** OS keychain on desktop, machine-local encrypted file for WebDev. */
	readonly securityLevel?: "os" | "machine";
	isEncryptionAvailable(): boolean;
	encryptString(plaintext: string): Buffer;
	decryptString(blob: Buffer): string;
}

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
	private db: AppDatabase;
	private vault: CredentialVault;
	private sessionKeys = new Map<string, string>();
	private encryptionAvailable: boolean;

	constructor(db: AppDatabase, vault: CredentialVault) {
		this.db = db;
		this.vault = vault;
		try {
			this.encryptionAvailable = vault.isEncryptionAvailable();
		} catch {
			this.encryptionAvailable = false;
		}
	}
	/** Store a credential for a provider. */
	async set(
		providerId: string,
		credential: { apiKey?: string; oauthToken?: string; refreshToken?: string },
		options?: { sessionOnly?: boolean },
	): Promise<CredentialStatus> {
		const id = providerId;
		const now = new Date().toISOString();

		const useSessionOnly =
			options?.sessionOnly === true || (!this.encryptionAvailable && process.platform !== "linux");
		if (useSessionOnly) {
			// No OS keychain means no persistent macOS/Windows fallback. Keep the
			// secret only for the current run and record no plaintext blob.
			if (credential.apiKey) this.sessionKeys.set(providerId, credential.apiKey);
			const status: CredentialStatus = "session_only";
			this.upsert(id, providerId, null, status, now);
			return status;
		}

		const plaintext = JSON.stringify(credential);
		let blob: Buffer;
		let status: CredentialStatus;
		if (this.encryptionAvailable) {
			try {
				blob = this.vault.encryptString(plaintext);
				status = this.vault.securityLevel === "machine" ? "weak_storage" : "stored";
			} catch {
				// isEncryptionAvailable() can succeed while the keychain daemon is
				// unavailable. Downgrade this process to session-only without
				// repeatedly invoking the broken keychain.
				this.encryptionAvailable = false;
				if (credential.apiKey) this.sessionKeys.set(providerId, credential.apiKey);
				status = "session_only";
				this.upsert(id, providerId, null, status, now);
				return status;
			}
		} else {
			// Electron documents weak storage only for Linux. Keep that explicit
			// instead of silently accepting a plaintext macOS/Windows fallback.
			blob = Buffer.from(plaintext, "utf8");
			status = "weak_storage";
		}

		this.upsert(id, providerId, blob, status, now);
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
			.select({
				credentialBlob: providerAccounts.credentialBlob,
				credentialStatus: providerAccounts.credentialStatus,
				updatedAt: providerAccounts.updatedAt,
			})
			.from(providerAccounts)
			.where(eq(providerAccounts.id, providerId))
			.get();

		if (!row) return null;

		let credential: { apiKey?: string; oauthToken?: string; refreshToken?: string } = {};

		if (row.credentialBlob) {
			try {
				const blob = Buffer.from(row.credentialBlob);
				const plaintext =
					(row.credentialStatus === "stored" || row.credentialStatus === "weak_storage") &&
					this.encryptionAvailable
						? this.vault.decryptString(blob)
						: blob.toString("utf8");
				credential = JSON.parse(plaintext);
			} catch {
				return {
					providerId,
					status: "invalid",
					updatedAt: row.updatedAt,
				};
			}
		}

		return {
			providerId,
			apiKey: credential.apiKey,
			oauthToken: credential.oauthToken,
			refreshToken: credential.refreshToken,
			status: row.credentialStatus as CredentialStatus,
			updatedAt: row.updatedAt,
		};
	}

	/** Remove a stored credential. */
	async remove(providerId: string): Promise<void> {
		this.sessionKeys.delete(providerId);
		this.db.delete(providerAccounts).where(eq(providerAccounts.id, providerId)).run();
	}

	/** Get the credential status for a provider (without revealing the secret). */
	async getStatus(providerId: string): Promise<CredentialStatus> {
		if (this.sessionKeys.has(providerId)) return "session_only";
		const row = this.db
			.select({ status: providerAccounts.credentialStatus })
			.from(providerAccounts)
			.where(eq(providerAccounts.id, providerId))
			.get();
		return (row?.status as CredentialStatus) ?? "missing";
	}

	/** List all provider credentials (without secrets). */
	async list(): Promise<Array<{ providerId: string; status: CredentialStatus }>> {
		const rows = this.db
			.select({ id: providerAccounts.id, status: providerAccounts.credentialStatus })
			.from(providerAccounts)
			.orderBy(asc(providerAccounts.id))
			.all();
		const result: Array<{ providerId: string; status: CredentialStatus }> = [];
		for (const row of rows) {
			result.push({
				providerId: row.id,
				status: row.status as CredentialStatus,
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

	private upsert(
		id: string,
		providerId: string,
		credentialBlob: Buffer | null,
		credentialStatus: CredentialStatus,
		updatedAt: string,
	): void {
		this.db
			.insert(providerAccounts)
			.values({ id, providerId, credentialBlob, credentialStatus, updatedAt })
			.onConflictDoUpdate({
				target: providerAccounts.id,
				set: { credentialBlob, credentialStatus, updatedAt },
			})
			.run();
	}
}
