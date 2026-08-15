import type { CredentialVault } from "@bear-harness/host-runtime";
import { safeStorage } from "electron";

export const electronCredentialVault: CredentialVault = {
	isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
	encryptString: (plaintext) => safeStorage.encryptString(plaintext),
	decryptString: (blob) => safeStorage.decryptString(blob),
};
