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
			const staleRead = await host.dispatch("character.draftFileGet", {
				id: draft.id,
				path: "character.yaml",
				expectedSha256: "0".repeat(64),
			});
			expect(staleRead).toMatchObject({
				ok: false,
				error: { kind: "conflict", reason: "character_draft_revision_mismatch" },
			});
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
			expect(
				system
					.prepare(
						"SELECT name FROM sqlite_master WHERE name IN ('character_drafts','character_draft_revisions')",
					)
					.all(),
			).toEqual([]);
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

it("reviews actual schema fields, transfers large files, rewrites references, exports bytes, pages and prunes drafts", async () => {
	const { host } = await setup();
	try {
		const draft = await create(host);
		let revision = 1;
		const schema = await host.dispatch("character.authoringSchema", {});
		assert(schema.ok);
		expect(schema.data.manifest.properties).toHaveProperty("state_schema");
		expect(schema.data.skill.properties).toHaveProperty("triggers");
		const bytes = Buffer.alloc(1024 * 1024 + 17, 93);
		const begin = await host.dispatch("character.draftTransfer", {
			action: "begin",
			id: draft.id,
			expectedRevision: revision,
			path: "assets/large.bin",
			size: bytes.length,
		});
		assert(begin.ok && begin.data.uploadId);
		for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
			const result = await host.dispatch("character.draftTransfer", {
				action: "append",
				id: draft.id,
				uploadId: begin.data.uploadId,
				offset,
				base64: bytes.subarray(offset, offset + 1024 * 1024).toString("base64"),
			});
			assert(result.ok);
		}
		const finish = await host.dispatch("character.draftTransfer", {
			action: "finish",
			id: draft.id,
			uploadId: begin.data.uploadId,
			expectedRevision: revision,
		});
		assert(finish.ok && finish.data.draft);
		revision = finish.data.draft.currentRevision;
		const moved = await host.dispatch("character.draftManage", {
			action: "move",
			id: draft.id,
			expectedRevision: revision,
			from: "assets/avatar.png",
			to: "assets/renamed.png",
		});
		assert(moved.ok && moved.data.draft);
		revision = moved.data.draft.currentRevision;
		expect(await content(host, draft.id, "character.yaml")).toContain("assets/renamed.png");
		expect(await content(host, draft.id, "character.yaml")).not.toContain("assets/avatar.png");
		const review = await host.dispatch("character.draftReview", {
			id: draft.id,
			expectedRevision: revision,
		});
		assert(review.ok);
		expect(review.data.issues).toEqual([]);
		expect(review.data.changes).toContainEqual({
			path: "assets/avatar.png",
			kind: "deleted",
			binary: true,
		});
		const diff = await host.dispatch("character.draftDiff", {
			id: draft.id,
			expectedRevision: revision,
			path: "character.yaml",
		});
		assert(diff.ok);
		expect(diff.data.before).toContain("assets/avatar.png");
		expect(diff.data.after).toContain("assets/renamed.png");
		const chunks: Buffer[] = [];
		let offset = 0;
		let total = 1;
		while (offset < total) {
			const part = await host.dispatch("character.draftExport", {
				id: draft.id,
				expectedRevision: revision,
				offset,
			});
			assert(part.ok);
			const chunk = Buffer.from(part.data.base64, "base64");
			chunks.push(chunk);
			offset += chunk.length;
			total = part.data.totalBytes;
		}
		const { unzipSync } = await import("fflate");
		const exported = unzipSync(Buffer.concat(chunks));
		const exportedBytes = exported["assets/large.bin"];
		assert(exportedBytes, "export must contain the uploaded binary asset");
		expect(exportedBytes.byteLength).toBe(bytes.byteLength);
		// Compare every byte natively instead of enumerating a million Buffer keys.
		expect(bytes.equals(exportedBytes), "export must preserve every uploaded byte").toBe(true);
		expect(exported).not.toHaveProperty("assets/avatar.png");
		const pruned = await host.dispatch("character.draftManage", {
			action: "prune",
			id: draft.id,
			expectedRevision: revision,
			keep: 1,
		});
		assert(pruned.ok);
		const history = await host.dispatch("character.draftListRevisions", { id: draft.id });
		assert(history.ok);
		expect(history.data.revisions.map((r) => r.revision)).toEqual([revision]);
		await create(host);
		const first = await host.dispatch("character.draftList", { limit: 1 });
		assert(first.ok && first.data.nextCursor);
		const second = await host.dispatch("character.draftList", {
			limit: 1,
			cursor: first.data.nextCursor,
		});
		assert(second.ok);
		expect(second.data.drafts).toHaveLength(1);
		expect(second.data.drafts[0]?.id).not.toBe(first.data.drafts[0]?.id);
		const deleted = await host.dispatch("character.draftManage", {
			action: "delete",
			id: draft.id,
			expectedRevision: revision,
		});
		assert(deleted.ok);
		expect((await host.dispatch("character.draftGet", { id: draft.id })).ok).toBe(false);
	} finally {
		await host.close();
	}
});

it("requires a current migration review, preserves compatible state and stores original values before replacing the package", async () => {
	const { host, root } = await setup();
	try {
		const storage = Reflect.get(host, "storage");
		const handle = storage.open("jizhou");
		const { companionStateDocuments, conversations } = await import("../src/storage/schema.js");
		handle.database.orm
			.insert(conversations)
			.values({ id: "migration-session", companionId: "jizhou" })
			.run();
		handle.database.orm
			.insert(companionStateDocuments)
			.values({
				id: "jizhou:character:global",
				companionId: "jizhou",
				scope: "global",
				domain: "character",
				stateJson: { relationship: { affinity: 42, summary: "keep me" } },
				revision: 1,
			})
			.run();
		handle.database.orm
			.insert(companionStateDocuments)
			.values({
				id: "jizhou:display:migration-session",
				companionId: "jizhou",
				scope: "conversation",
				conversationId: "migration-session",
				domain: "display",
				stateJson: { sceneId: "study", expressionId: "reflective" },
				revision: 1,
			})
			.run();
		storage.release(handle);
		const draft = await create(host);
		const { parseDocument } = await import("yaml");
		const doc = parseDocument(await content(host, draft.id, "character.yaml"));
		doc.setIn(
			["visual", "expressions"],
			[{ id: "calm", label: "Calm", asset: "assets/avatar.png", use_when: "At rest." }],
		);
		const patch = await host.dispatch("character.draftPatch", {
			id: draft.id,
			expectedRevision: 1,
			files: { "character.yaml": { encoding: "utf8", content: String(doc) } },
		});
		assert(patch.ok);
		const review = await host.dispatch("character.draftReview", {
			id: draft.id,
			expectedRevision: 2,
		});
		assert(review.ok && review.data.migration);
		expect(review.data.migration.changes).toEqual([
			{
				scope: "conversation",
				conversationId: "migration-session",
				field: "display.expressionId",
				before: '"reflective"',
				after: '"calm"',
			},
		]);
		expect(
			await host.dispatch("character.draftPublish", { id: draft.id, expectedRevision: 2 }),
		).toMatchObject({ ok: false, error: { reason: "character_state_migration_review_required" } });
		const applied = await host.dispatch("character.draftPublish", {
			id: draft.id,
			expectedRevision: 2,
			migrationToken: review.data.migration.token,
		});
		assert(applied.ok, JSON.stringify(applied));
		const next = storage.open("jizhou");
		const rows = next.database.orm.select().from(companionStateDocuments).all();
		expect(
			rows.find((row: { domain: string }) => row.domain === "character").stateJson.relationship
				.affinity,
		).toBe(42);
		expect(
			rows.find((row: { domain: string }) => row.domain === "display").stateJson.expressionId,
		).toBe("calm");
		storage.release(next);
		const { readdir } = await import("node:fs/promises");
		const backups = await readdir(join(root, "companions/jizhou/package-migrations"));
		expect(backups).toHaveLength(1);
		expect(
			await readFile(join(root, "companions/jizhou/package-migrations", backups[0]!), "utf8"),
		).toContain("reflective");
		const journal = JSON.parse(
			await readFile(join(root, "companions/jizhou/package-migrations", backups[0]!), "utf8"),
		);
		await writeFile(
			join(root, "companions/jizhou/package-migration.json"),
			JSON.stringify(journal),
		);
		const recovered = storage.open("jizhou");
		expect(
			recovered.database.orm
				.select()
				.from(companionStateDocuments)
				.all()
				.find((row: { domain: string }) => row.domain === "display").stateJson.expressionId,
		).toBe("calm");
		storage.release(recovered);
		await writeFile(
			join(root, "characters/jizhou/character.yaml"),
			await readFile(join(characterRoot, "jizhou/character.yaml")),
		);
		await writeFile(
			join(root, "companions/jizhou/package-migration.json"),
			JSON.stringify(journal),
		);
		const rolledBack = storage.open("jizhou");
		expect(
			rolledBack.database.orm
				.select()
				.from(companionStateDocuments)
				.all()
				.find((row: { domain: string }) => row.domain === "display").stateJson.expressionId,
		).toBe("reflective");
		storage.release(rolledBack);
	} finally {
		await host.close();
	}
});

it("uses real isolated Pi trial handles and the restricted tool registry and cleans up after close", async () => {
	const { host, root } = await setup();
	try {
		await host.dispatch("provider.customUpsert", {
			providerId: "trial-test",
			name: "Trial test",
			baseUrl: "https://example.invalid/v1",
			models: [{ id: "test-model" }],
		});
		await host.dispatch("provider.setApiKey", {
			providerId: "trial-test",
			apiKey: "test-only",
			sessionOnly: true,
		});
		const draft = await create(host);
		const trial = await host.dispatch("character.trial", {
			action: "start",
			id: draft.id,
			expectedRevision: 1,
			providerId: "trial-test",
			modelId: "test-model",
		});
		assert(trial.ok, JSON.stringify(trial));
		expect(trial.data.detail?.branch.entries.filter((entry) => entry.type === "message")).toEqual(
			[],
		);
		const resource = Reflect.get(Reflect.get(host, "trials"), "handles").get(trial.data.trialId);
		expect(resource.pi.snapshot(resource.sessionId).getActiveToolNames().sort()).toEqual([
			"host_canon",
			"host_choices",
			"host_media",
			"host_state",
			"role_skill",
		]);
		expect(resource.root).toContain(join(root, "companions/jizhou/drafts", draft.id, "trials"));
		const closed = await host.dispatch("character.trial", {
			action: "close",
			trialId: trial.data.trialId,
		});
		assert(closed.ok);
		expect(
			(await host.dispatch("character.trial", { action: "get", trialId: trial.data.trialId })).ok,
		).toBe(false);
		const { access } = await import("node:fs/promises");
		await expect(access(resource.root)).rejects.toThrow();
	} finally {
		await host.close();
	}
});

it("moves declared references without rewriting unrelated state fields with the same names", async () => {
	const { moveDraftFiles } = await import("../src/companion/character-draft-files.js");
	const files = {
		"character.yaml": Buffer.from(
			"visual:\n  avatar: assets/old.png\nstate_schema:\n  default:\n    asset: assets/old.png\n",
		),
		"assets/old.png": Buffer.from([1, 2, 3]),
		"skills/read/SKILL.md": Buffer.from(
			"---\nname: read\nresources:\n  - path: ../reference.md\ncompletion:\n  state:\n    path: ../reference.md\n---\n[Reference](../reference.md#details)\n",
		),
		"skills/reference.md": Buffer.from("# Reference"),
	};
	const moved = moveDraftFiles(files, "assets/old.png", "assets/new.png");
	expect(moved["character.yaml"]?.toString()).toContain("avatar: assets/new.png");
	expect(moved["character.yaml"]?.toString()).toContain("asset: assets/old.png");
	const skillMoved = moveDraftFiles(moved, "skills/reference.md", "canon/reference.md");
	expect(skillMoved["skills/read/SKILL.md"]?.toString()).toContain(
		"path: ../../canon/reference.md",
	);
	expect(skillMoved["skills/read/SKILL.md"]?.toString()).toContain("path: ../reference.md");
	expect(skillMoved["skills/read/SKILL.md"]?.toString()).toContain(
		"[Reference](../../canon/reference.md#details)",
	);
});
