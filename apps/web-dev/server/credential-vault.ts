import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialVault } from "@bear-harness/host-runtime";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createWebCredentialVault(dataDir: string): CredentialVault {
	const securityDir = join(dataDir, "security");
	mkdirSync(securityDir, { recursive: true, mode: 0o700 });
	const key = loadKey(securityDir);
	return {
		securityLevel: "machine",
		isEncryptionAvailable: () => true,
		encryptString: (plaintext) => {
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
			return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), encrypted]);
		},
		decryptString: (blob) => {
			if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== VERSION) {
				throw new Error("unsupported web credential blob");
			}
			const iv = blob.subarray(1, 1 + IV_BYTES);
			const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
			const encrypted = blob.subarray(1 + IV_BYTES + TAG_BYTES);
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
		},
	};
}

function loadKey(securityDir: string): Buffer {
	const configured = process.env.BEAR_WEB_DEV_MASTER_KEY;
	if (configured) return createHash("sha256").update(configured, "utf8").digest();
	const keyPath = join(securityDir, "web-vault.key");
	try {
		const key = readFileSync(keyPath);
		if (key.length !== 32) throw new Error("invalid web vault key");
		chmodSync(keyPath, 0o600);
		return key;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const key = randomBytes(32);
		writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
		return key;
	}
}
