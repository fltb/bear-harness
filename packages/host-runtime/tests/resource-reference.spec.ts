// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialVault } from "../src/providers/credential-store.js";
import { ResourceReferenceService } from "../src/resources/reference-service.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";

const roots: string[] = [];
const vault: CredentialVault = {
	securityLevel: "os",
	isEncryptionAvailable: () => true,
	encryptString: (value) => Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5),
	decryptString: (value) =>
		Buffer.from(value)
			.map((byte) => byte ^ 0xa5)
			.toString("utf8"),
};

function setup() {
	const root = mkdtempSync(join(tmpdir(), "bear-resource-ref-"));
	roots.push(root);
	const database = new Database(join(root, "db"));
	database.migrate(MIGRATIONS);
	return { root, database, service: new ResourceReferenceService(database.orm, vault) };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ResourceReferenceService", () => {
	it("stores an encrypted locator and returns a path-free view", () => {
		const { root, database, service } = setup();
		const path = join(root, "report.txt");
		writeFileSync(path, "first");
		const view = service.grant(path);
		expect(view).toMatchObject({ kind: "file", displayName: "report.txt", state: "available" });
		expect(view).not.toHaveProperty("locator");
		const stored = database.connection
			.prepare("SELECT encrypted_locator_json FROM resource_refs WHERE id = ?")
			.get(view.id) as { encrypted_locator_json: Uint8Array };
		expect(Buffer.from(stored.encrypted_locator_json).toString("utf8")).not.toContain(path);
		database.close();
	});

	it("detects content changes and makes revocation irreversible for future resolves", () => {
		const { root, database, service } = setup();
		const path = join(root, "notes.txt");
		writeFileSync(path, "before");
		const view = service.grant(path);
		writeFileSync(path, "after and larger");
		expect(service.resolve(view.id).state).toBe("changed");
		service.revoke(view.id);
		expect(() => service.resolve(view.id)).toThrow("resource_not_found");
		const stored = database.connection
			.prepare("SELECT length(encrypted_locator_json) AS bytes FROM resource_refs WHERE id = ?")
			.get(view.id) as { bytes: number };
		expect(stored.bytes).toBe(0);
		database.close();
	});
});
