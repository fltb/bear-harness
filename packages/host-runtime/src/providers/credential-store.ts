/**
 * CredentialStore — persists provider API keys and OAuth tokens through an
 * injected platform vault.
 *
 * The vault abstracts the OS-backed encryption layer (Electron's safeStorage
 * in the desktop app). Credentials are persisted only when the vault reports
 * an available encrypted backend. If the backend is unavailable or is
 * Electron's `basic_text` backend, credentials remain in memory for this
 * session and no credential blob is written.
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
 * for a vault that reports an encrypted `securityLevel`; a `session` level
 * explicitly forbids persistence even if the backend reports availability.
 */
export interface CredentialVault {
	/** OS keychain, machine-local encrypted file, or session-only storage. */
	readonly securityLevel?: "os" | "machine" | "session";
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

type CredentialPayload = {
	apiKey?: string;
	oauthToken?: string;
	refreshToken?: string;
};

type SessionCredential = {
	credential: CredentialPayload;
	updatedAt: string;
};

export class CredentialStore {
	private db: AppDatabase;
	private vault: CredentialVault;
	private sessionCredentials = new Map<string, SessionCredential>();
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
		credential: CredentialPayload,
		options?: { sessionOnly?: boolean },
	): Promise<CredentialStatus> {
		const id = providerId;
		const now = new Date().toISOString();
		const useSessionOnly = options?.sessionOnly === true || !this.canPersistCredentials();

		this.sessionCredentials.delete(providerId);
		if (useSessionOnly) {
			this.sessionCredentials.set(providerId, { credential: { ...credential }, updatedAt: now });
			this.upsert(id, providerId, null, "session_only", now);
			return "session_only";
		}

		const plaintext = JSON.stringify(credential);
		let blob: Buffer;
		let status: CredentialStatus;
		try {
			blob = this.vault.encryptString(plaintext);
			status = this.vault.securityLevel === "machine" ? "weak_storage" : "stored";
		} catch {
			// Availability can be reported before the OS keychain daemon is
			// usable. Downgrade this process to session-only and do not retry it.
			this.encryptionAvailable = false;
			this.sessionCredentials.set(providerId, { credential: { ...credential }, updatedAt: now });
			this.upsert(id, providerId, null, "session_only", now);
			return "session_only";
		}

		this.upsert(id, providerId, blob, status, now);
		return status;
	}

	/** Retrieve a credential for a provider. */
	async get(providerId: string): Promise<ProviderCredential | null> {
		const session = this.sessionCredentials.get(providerId);
		if (session) {
			return {
				providerId,
				...session.credential,
				status: "session_only",
				updatedAt: session.updatedAt,
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
		if (!row.credentialBlob) {
			return {
				providerId,
				status: row.credentialStatus as CredentialStatus,
				updatedAt: row.updatedAt,
			};
		}

		// Never interpret a persisted blob as UTF-8. A credential blob is
		// readable only through an available encrypted vault.
		if (
			(row.credentialStatus !== "stored" && row.credentialStatus !== "weak_storage") ||
			!this.canPersistCredentials()
		) {
			this.clearBlob(providerId, "unavailable");
			return { providerId, status: "unavailable", updatedAt: row.updatedAt };
		}

		try {
			const credential = JSON.parse(
				this.vault.decryptString(Buffer.from(row.credentialBlob)),
			) as CredentialPayload;
			return {
				providerId,
				apiKey: credential.apiKey,
				oauthToken: credential.oauthToken,
				refreshToken: credential.refreshToken,
				status: row.credentialStatus as CredentialStatus,
				updatedAt: row.updatedAt,
			};
		} catch {
			this.clearBlob(providerId, "invalid");
			return {
				providerId,
				status: "invalid",
				updatedAt: row.updatedAt,
			};
		}
	}

	/** Remove a stored credential. */
	async remove(providerId: string): Promise<void> {
		this.sessionCredentials.delete(providerId);
		this.db.delete(providerAccounts).where(eq(providerAccounts.id, providerId)).run();
	}

	/** Get the credential status for a provider (without revealing the secret). */
	async getStatus(providerId: string): Promise<CredentialStatus> {
		if (this.sessionCredentials.has(providerId)) return "session_only";
		const row = this.db
			.select({ status: providerAccounts.credentialStatus })
			.from(providerAccounts)
			.where(eq(providerAccounts.id, providerId))
			.get();
		const status = (row?.status as CredentialStatus) ?? "missing";
		if (
			row &&
			(status === "stored" || status === "weak_storage") &&
			!this.canPersistCredentials()
		) {
			this.clearBlob(providerId, "unavailable");
			return "unavailable";
		}
		return status;
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
			const status = row.status as CredentialStatus;
			if ((status === "stored" || status === "weak_storage") && !this.canPersistCredentials()) {
				this.clearBlob(row.id, "unavailable");
				result.push({ providerId: row.id, status: "unavailable" });
				continue;
			}
			result.push({ providerId: row.id, status });
		}
		for (const [providerId] of this.sessionCredentials) {
			if (!result.some((r) => r.providerId === providerId)) {
				result.push({ providerId, status: "session_only" });
			}
		}
		return result;
	}

	private clearBlob(providerId: string, status: "unavailable" | "invalid"): void {
		this.db
			.update(providerAccounts)
			.set({
				credentialBlob: null,
				credentialStatus: status,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(providerAccounts.id, providerId))
			.run();
	}

	private canPersistCredentials(): boolean {
		if (!this.encryptionAvailable) return false;
		try {
			// `session` is used by Electron's basic_text backend. Undefined is
			// retained for compatible injected vaults whose encryption contract
			// predates securityLevel.
			return this.vault.securityLevel !== "session";
		} catch {
			return false;
		}
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
