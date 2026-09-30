import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HostRuntime } from "../src/runtime.js";

const roots: string[] = [];
const characterRoot = fileURLToPath(new URL("./fixtures/characters", import.meta.url));
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "bear-studio-"));
	roots.push(root);
	const open = () =>
		new HostRuntime({
			dataDir: root,
			characterSeedRoot: characterRoot,
			productConfig: { defaultCharacterId: "jizhou" },
		});
	const host = open();
	await host.start();
	return { root, host, open };
}
async function content(host: HostRuntime, id: string, path: string) {
	const result = await host.dispatch("character.draftFileGet", { id, path, offset: 0 });
	assert(result.ok);
	return Buffer.from(result.data.base64, "base64").toString("utf8");
}
async function create(host: HostRuntime, characterId = "jizhou") {
	const result = await host.dispatch("character.draftCreate", { characterId });
	assert(result.ok, JSON.stringify(result));
	return result.data.draft;
}
describe("character author drafts", () => {
	it("takes an exact package snapshot, keeps bodies outside settings.db and isolates owners", async () => {
		const { host, root } = await setup();
		try {
			const draft = await create(host);
			expect(draft.baseSha256).toHaveLength(64);
			const original = await readFile(join(root, "characters/jizhou/character.yaml"), "utf8");
			expect(await content(host, draft.id, "character.yaml")).toBe(original);
			expect(draft.files["character.yaml"]).not.toHaveProperty("content");
			const copy = await host.dispatch("character.draftCreate", {
				characterId: "another",
				basePackageId: "jizhou",
				name: "Another",
			});
			assert(copy.ok);
			expect(await content(host, copy.data.draft.id, "character.yaml")).toContain("id: another");
			expect(copy.data.draft.baseSha256).toBeUndefined();
			const stored = JSON.parse(
				await readFile(join(root, "companions/jizhou/drafts", draft.id, "current.json"), "utf8"),
			);
			expect(stored.schemaVersion).toBe(1);
			expect(
				(await host.dispatch("character.draftGet", { id: draft.id.replace("jizhou~", "another~") }))
					.ok,
			).toBe(false);
			const system = Reflect.get(host, "storage").system.connection;
			expect(system.prepare("SELECT count(*) AS n FROM character_drafts").get().n).toBe(0);
		} finally {
			await host.close();
		}
	});
	it("saves invalid YAML verbatim, survives Host restart, detects stale saves and restores deletions", async () => {
		const { host, open } = await setup();
		let current = host;
		try {
			const draft = await create(current);
			const patch = await current.dispatch("character.draftPatch", {
				id: draft.id,
				expectedRevision: 1,
				files: {
					"character.yaml": { encoding: "utf8", content: "broken: [" },
					"canon/new.md": { encoding: "utf8", content: "# New\nA fact." },
				},
			});
			assert(patch.ok);
			expect(await content(current, draft.id, "character.yaml")).toBe("broken: [");
			expect(
				(await current.dispatch("character.draftValidate", { id: draft.id, expectedRevision: 2 }))
					.ok,
			).toBe(false);
			expect(
				await current.dispatch("character.draftPatch", {
					id: draft.id,
					expectedRevision: 1,
					files: { "x.txt": { encoding: "utf8", content: "stale" } },
				}),
			).toMatchObject({ ok: false, error: { kind: "conflict" } });
			await current.close();
			current = open();
			await current.start();
			expect(await content(current, draft.id, "canon/new.md")).toContain("A fact.");
			const removed = await current.dispatch("character.draftPatch", {
				id: draft.id,
				expectedRevision: 2,
				files: { "canon/new.md": null },
			});
			assert(removed.ok);
			expect(removed.data.draft.files).not.toHaveProperty("canon/new.md");
			const restore = await current.dispatch("character.draftRestoreRevision", {
				id: draft.id,
				expectedRevision: 3,
				sourceRevision: 2,
			});
			assert(restore.ok);
			expect(restore.data.draft.currentRevision).toBe(4);
			expect(await content(current, draft.id, "canon/new.md")).toContain("A fact.");
			const list = await current.dispatch("character.draftList", {});
			assert(list.ok);
			expect(list.data.drafts[0]).toMatchObject({ id: draft.id, currentRevision: 4 });
			expect(list.data.drafts[0]).not.toHaveProperty("files");
		} finally {
			await current.close();
		}
	});
	it("applies existing complete packages, retains binary files, and blocks changes made outside the editor", async () => {
		const { host, root } = await setup();
		try {
			const draft = await create(host);
			const original = await content(host, draft.id, "character.yaml");
			const patch = await host.dispatch("character.draftPatch", {
				id: draft.id,
				expectedRevision: 1,
				files: {
					"character.yaml": {
						encoding: "utf8",
						content: original.replace("name: 极昼", "name: 新极昼"),
					},
					"canon/new.md": {
						encoding: "utf8",
						content: "# A new reference\nOriginal test content.",
					},
				},
			});
			assert(patch.ok);
			await writeFile(join(root, "characters/jizhou/external.txt"), "external change");
			expect(
				await host.dispatch("character.draftPublish", { id: draft.id, expectedRevision: 2 }),
			).toMatchObject({ ok: false, error: { reason: "character_package_revision_mismatch" } });
			await rm(join(root, "characters/jizhou/external.txt"));
			const applied = await host.dispatch("character.draftPublish", {
				id: draft.id,
				expectedRevision: 2,
			});
			assert(applied.ok, JSON.stringify(applied));
			expect(applied.data.draft.status).toBe("published");
			expect(await readFile(join(root, "characters/jizhou/canon/new.md"), "utf8")).toContain(
				"Original test content.",
			);
			const repeated = await host.dispatch("character.draftPublish", {
				id: draft.id,
				expectedRevision: 2,
			});
			expect(repeated.ok).toBe(true);
			for (const [path, file] of Object.entries(draft.files))
				if (file.encoding === "base64") {
					const response = await host.dispatch("character.draftFileGet", {
						id: draft.id,
						path,
						offset: 0,
					});
					assert(response.ok);
					expect(
						(await readFile(join(root, "characters/jizhou", path)))
							.subarray(0, 256 * 1024)
							.toString("base64"),
					).toBe(response.data.base64);
				}
		} finally {
			await host.close();
		}
	});
	it("creates new text-only characters without model setup and protects package identity", async () => {
		const { host } = await setup();
		try {
			const draft = await create(host, "new-role");
			const source = await content(host, draft.id, "character.yaml");
			expect(source).toContain('summary: ""');
			const patch = await host.dispatch("character.draftPatch", {
				id: draft.id,
				expectedRevision: 1,
				files: {
					"character.yaml": {
						encoding: "utf8",
						content: source.replace('summary: ""', "summary: A quiet librarian."),
					},
				},
			});
			assert(patch.ok);
			const applied = await host.dispatch("character.draftPublish", {
				id: draft.id,
				expectedRevision: 2,
			});
			expect(applied).toMatchObject({ ok: true, data: { character: { id: "new-role" } } });
			await host.dispatch("character.draftPatch", {
				id: draft.id,
				expectedRevision: 2,
				files: {
					"character.yaml": {
						encoding: "utf8",
						content: source.replace("id: new-role", "id: jizhou"),
					},
				},
			});
			expect(
				(await host.dispatch("character.draftPublish", { id: draft.id, expectedRevision: 3 })).ok,
			).toBe(false);
		} finally {
			await host.close();
		}
	});
	it("rejects unsafe paths and symlink blobs without modifying installed files", async () => {
		const { host, root } = await setup();
		try {
			const draft = await create(host);
			for (const path of [
				"../escape.txt",
				"/absolute.txt",
				"C:/file",
				"assets/../../secret",
				"assets\\escape.txt",
				"CON",
			]) {
				expect(
					(
						await host.dispatch("character.draftPatch", {
							id: draft.id,
							expectedRevision: 1,
							files: { [path]: { encoding: "utf8", content: "unsafe" } },
						})
					).ok,
				).toBe(false);
			}
			const file = draft.files["character.yaml"];
			assert(file);
			const blob = join(root, "companions/jizhou/drafts", draft.id, file.sha256);
			await rm(blob);
			await symlink(join(root, "characters/jizhou/character.yaml"), blob);
			expect(
				(
					await host.dispatch("character.draftFileGet", {
						id: draft.id,
						path: "character.yaml",
						offset: 0,
					})
				).ok,
			).toBe(false);
		} finally {
			await host.close();
		}
	});
});
