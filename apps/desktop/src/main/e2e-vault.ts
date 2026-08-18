import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { CredentialVault } from "@bear-harness/host-runtime";

/**
 * Source-e2e credential vault.
 *
 * The packaged path encrypts credentials with Electron `safeStorage`, which on
 * macOS stores keys in the login Keychain — provisioning a fresh temp data dir
 * makes the keychain entry missing, so macOS pops an authorization dialog that
 * blocks the RPC until the test times out. E2E runs are isolated throwaway
 * environments, so a fixed AES-GCM key derived from a literal is sufficient:
 * it rounds trips like the real vault and never touches the keychain.
 */
const E2E_VAULT_KEY = createHash("sha256").update("bear-harness-source-e2e-only").digest();

export const e2eCredentialVault: CredentialVault = {
	securityLevel: "machine",
	isEncryptionAvailable: () => true,
	encryptString: (plaintext) => {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", E2E_VAULT_KEY, iv);
		const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
	},
	decryptString: (blob) => {
		const iv = blob.subarray(0, 12);
		const tag = blob.subarray(12, 28);
		const data = blob.subarray(28);
		const decipher = createDecipheriv("aes-256-gcm", E2E_VAULT_KEY, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
	},
};
