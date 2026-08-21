// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const safeStorage = vi.hoisted(() => ({
	available: true,
	backend: "gnome_libsecret",
	isEncryptionAvailable: vi.fn(() => safeStorage.available),
	getSelectedStorageBackend: vi.fn(() => safeStorage.backend),
	encryptString: vi.fn((plaintext: string) => Buffer.from(`encrypted:${plaintext}`, "utf8")),
	decryptString: vi.fn((blob: Buffer) => blob.toString("utf8").slice("encrypted:".length)),
}));

vi.mock("electron", () => ({ safeStorage }));

import { electronCredentialVault } from "../src/main/electron-credential-vault.js";

beforeEach(() => {
	safeStorage.available = true;
	safeStorage.backend = "gnome_libsecret";
	vi.clearAllMocks();
});

describe("electronCredentialVault", () => {
	it("reports session security when safeStorage is unavailable", () => {
		safeStorage.available = false;

		expect(electronCredentialVault.isEncryptionAvailable()).toBe(false);
		expect(electronCredentialVault.securityLevel).toBe("session");
	});

	it("reports session security for Electron basic_text", () => {
		safeStorage.backend = "basic_text";

		expect(electronCredentialVault.isEncryptionAvailable()).toBe(true);
		expect(electronCredentialVault.securityLevel).toBe("session");
	});

	it("reports OS security for a strong safeStorage backend", () => {
		safeStorage.backend = "gnome_libsecret";

		expect(electronCredentialVault.securityLevel).toBe("os");
		expect(electronCredentialVault.encryptString("secret").toString("utf8")).toBe(
			"encrypted:secret",
		);
		expect(electronCredentialVault.decryptString(Buffer.from("encrypted:secret"))).toBe("secret");
	});
});
