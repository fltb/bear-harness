/**
 * CredentialStore — persists trusted Host API keys and OAuth tokens through an
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

import type {
	AuthOperationOptions,
	Credential as PiCredential,
	CredentialInfo as PiCredentialInfo,
	CredentialStore as PiCredentialStore,
} from "@earendil-works/pi-ai";
import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { providerAccounts } from "../storage/schema.js";

const INTERNAL_CREDENTIAL_PREFIX = "$bear:";
/** Reserved vault entry for the installation-wide remote embedding service. */
export const REMOTE_EMBEDDING_CREDENTIAL_ID = `${INTERNAL_CREDENTIAL_PREFIX}embedding:remote`;

/**
 * Platform credential encryption boundary. The desktop app injects an
 * Electron `safeStorage`-backed implementation; tests and other hosts may
 * provide an in-memory vault. `encryptString`/`decryptString` must round-trip
 * for a vault that reports an encrypted `securityLevel`; a `session` level
 * explicitly forbids persistence even if the backend reports availability.
 */
export interface CredentialVault {
	/** OS keychain, machine-local encrypted file, or session-only storage. */
	readonly securityLevel: "os" | "machine" | "session";
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
	piCredential?: PiCredential;
	status: CredentialStatus;
	updatedAt: string;
}

type CredentialPayload = {
	apiKey?: string;
	piCredential?: PiCredential;
};

type SessionCredential = {
	credential: CredentialPayload;
	updatedAt: string;
};

export class CredentialStore {
	private readonly db: AppDatabase;
	private readonly vault: CredentialVault;
	private sessionCredentials = new Map<string, SessionCredential>();

	constructor(db: AppDatabase, vault: CredentialVault) {
		this.db = db;
		this.vault = vault;
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
			// usable. Keep the replacement in this process as session-only.
			this.sessionCredentials.set(providerId, { credential: { ...credential }, updatedAt: now });
			this.upsert(id, providerId, null, "session_only", now);
			return "session_only";
		}

		this.upsert(id, providerId, blob, status, now);
		return status;
	}

	/** Retrieve a credential for a provider. */
	async get(providerId: string): Promise<ProviderCredential | null> {
		return this.read(providerId);
	}

	/** Trusted Host-only synchronous read for constructors that consume configuration synchronously. */
	read(providerId: string): ProviderCredential | null {
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
		// readable only through an available encrypted vault. Availability is
		// derived for this read and never persisted over the stored status.
		if (
			(row.credentialStatus !== "stored" && row.credentialStatus !== "weak_storage") ||
			!this.canPersistCredentials()
		) {
			return { providerId, status: "unavailable", updatedAt: row.updatedAt };
		}

		try {
			const credential = JSON.parse(
				this.vault.decryptString(Buffer.from(row.credentialBlob)),
			) as CredentialPayload;
			return {
				providerId,
				apiKey: credential.apiKey,
				piCredential: credential.piCredential,
				status: row.credentialStatus as CredentialStatus,
				updatedAt: row.updatedAt,
			};
		} catch {
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
			if (row.id.startsWith(INTERNAL_CREDENTIAL_PREFIX)) continue;
			const status = row.status as CredentialStatus;
			if ((status === "stored" || status === "weak_storage") && !this.canPersistCredentials()) {
				result.push({ providerId: row.id, status: "unavailable" });
				continue;
			}
			result.push({ providerId: row.id, status });
		}
		for (const [providerId] of this.sessionCredentials) {
			if (providerId.startsWith(INTERNAL_CREDENTIAL_PREFIX)) continue;
			if (!result.some((r) => r.providerId === providerId)) {
				result.push({ providerId, status: "session_only" });
			}
		}
		return result;
	}

	private canPersistCredentials(): boolean {
		try {
			return this.vault.isEncryptionAvailable() && this.vault.securityLevel !== "session";
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

/**
 * Pi's credential persistence contract backed by the Host's encrypted vault.
 * Pi credentials remain opaque so provider-specific OAuth metadata survives
 * login and refresh without Host-owned token parsing.
 */
export class EncryptedPiCredentialStore implements PiCredentialStore {
	private readonly queues = new Map<string, Promise<void>>();
	private readonly sessionOnly = new Set<string>();

	constructor(private readonly store: CredentialStore) {}

	setSessionOnly(providerId: string, enabled: boolean): void {
		if (enabled) this.sessionOnly.add(providerId);
		else this.sessionOnly.delete(providerId);
	}

	async read(
		providerId: string,
		options?: AuthOperationOptions,
	): Promise<PiCredential | undefined> {
		options?.signal?.throwIfAborted();
		const stored = await this.store.get(providerId);
		options?.signal?.throwIfAborted();
		if (!stored || stored.status === "invalid" || stored.status === "unavailable") return undefined;
		if (stored.piCredential) return stored.piCredential;
		return stored.apiKey ? { type: "api_key", key: stored.apiKey } : undefined;
	}

	async list(options?: AuthOperationOptions): Promise<readonly PiCredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const accounts = await this.store.list();
		const credentials: PiCredentialInfo[] = [];
		for (const account of accounts) {
			const credential = await this.read(account.providerId, options);
			if (credential) credentials.push({ providerId: account.providerId, type: credential.type });
		}
		return credentials;
	}

	modify(
		providerId: string,
		fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
		options?: AuthOperationOptions,
	): Promise<PiCredential | undefined> {
		return this.exclusive(providerId, options, async () => {
			const next = await fn(await this.read(providerId, options));
			options?.signal?.throwIfAborted();
			if (!next) {
				await this.store.remove(providerId);
				return undefined;
			}
			await this.store.set(
				providerId,
				{ piCredential: next },
				{ sessionOnly: this.sessionOnly.has(providerId) },
			);
			return next;
		});
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.exclusive(providerId, options, async () => {
			await this.store.remove(providerId);
		});
	}

	private async exclusive<T>(
		providerId: string,
		options: AuthOperationOptions | undefined,
		operation: () => Promise<T>,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		const previous = this.queues.get(providerId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => current);
		this.queues.set(providerId, tail);
		await previous;
		try {
			options?.signal?.throwIfAborted();
			return await operation();
		} finally {
			release();
			if (this.queues.get(providerId) === tail) this.queues.delete(providerId);
		}
	}
}
