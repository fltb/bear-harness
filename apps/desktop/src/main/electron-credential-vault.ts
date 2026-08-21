import type { CredentialVault } from "@bear-harness/host-runtime";
import { safeStorage } from "electron";

const BASIC_TEXT_BACKEND = "basic_text";
const STRONG_LINUX_BACKENDS: Record<string, true> = {
	gnome_libsecret: true,
	kwallet: true,
	kwallet5: true,
	kwallet6: true,
};

function getSecurityLevel(): CredentialVault["securityLevel"] {
	try {
		if (!safeStorage.isEncryptionAvailable()) return "session";
		const backend = safeStorage.getSelectedStorageBackend();
		if (backend === BASIC_TEXT_BACKEND) return "session";
		if (process.platform === "linux" && STRONG_LINUX_BACKENDS[backend] !== true) return "session";
		return "os";
	} catch {
		return "session";
	}
}

export const electronCredentialVault: CredentialVault = {
	get securityLevel() {
		return getSecurityLevel();
	},
	isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
	encryptString: (plaintext) => safeStorage.encryptString(plaintext),
	decryptString: (blob) => safeStorage.decryptString(blob),
};
