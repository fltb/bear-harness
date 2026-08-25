// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialVault } from "../src/providers/credential-store.js";
import { ResourceContentService } from "../src/resources/content-service.js";
import { ResourceMutationService } from "../src/resources/mutation-service.js";
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
		const view = service.grant(path, { securityBookmark: "private-bookmark" });
		expect(view).toMatchObject({ kind: "file", displayName: "report.txt", state: "available" });
		expect(view).not.toHaveProperty("locator");
		const stored = database.connection
			.prepare("SELECT encrypted_locator_json FROM resource_refs WHERE id = ?")
			.get(view.id) as { encrypted_locator_json: Uint8Array };
		expect(Buffer.from(stored.encrypted_locator_json).toString("utf8")).not.toContain(path);
		expect(Buffer.from(stored.encrypted_locator_json).toString("utf8")).not.toContain(
			"private-bookmark",
		);
		database.close();
	});

	it("relocates the same resource and preserves its prior revision", () => {
		const { root, database, service } = setup();
		const original = join(root, "original.txt");
		const relocated = join(root, "relocated.txt");
		writeFileSync(original, "stable identity");
		const view = service.grant(original);
		renameSync(original, relocated);
		expect(service.relocate(view.id, relocated)).toMatchObject({ id: view.id, state: "available" });
		expect(service.resolve(view.id).locator.canonicalPath).toBe(relocated);
		expect(
			database.connection
				.prepare("SELECT count(*) AS count FROM resource_revisions WHERE resource_id = ?")
				.get(view.id),
		).toEqual({ count: 1 });
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

	it("performs bounded reads, records evidence, and skips ignored directory entries", () => {
		const { root, database, service } = setup();
		const folder = join(root, "project");
		mkdirSync(join(folder, "node_modules"), { recursive: true });
		writeFileSync(join(folder, "README.md"), "hello resource");
		writeFileSync(join(folder, "node_modules", "hidden.js"), "hidden");
		const file = service.grant(join(folder, "README.md"));
		const directory = service.grant(folder, { access: "read-write" });
		const content = new ResourceContentService(database.orm, service);
		expect(content.readText(file.id, { reader: "companion" }).text).toBe("hello resource");
		expect(content.listDirectory(directory.id).entries.map((entry) => entry.name)).toEqual([
			"README.md",
		]);
		const search = content.search(directory.id, "hello resource");
		expect(search.hits.map((entry) => entry.name)).toEqual(["README.md"]);
		expect(search.revision).toMatchObject({ resourceId: directory.id, entryCount: 1 });
		expect(database.connection.prepare("SELECT reader FROM resource_reads").get()).toEqual({
			reader: "companion",
		});
		database.close();
	});

	it("performs atomic resource mutations with baseline conflicts and undo", () => {
		const { root, database, service } = setup();
		const path = join(root, "editable.txt");
		writeFileSync(path, "before");
		const view = service.grant(path, { access: "read-write" });
		const baseline = service.resolve(view.id).baseline;
		const mutations = new ResourceMutationService(database.orm, service);
		const journalId = mutations.modify(view.id, Buffer.from("after"), baseline);
		expect(readFileSync(path, "utf8")).toBe("after");
		expect(() => mutations.modify(view.id, Buffer.from("again"), baseline)).toThrow();
		mutations.undo(journalId);
		expect(readFileSync(path, "utf8")).toBe("before");
		database.close();
	});
});
