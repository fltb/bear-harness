import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HostRuntime } from "../src/runtime.js";

const roots: string[] = [];
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRuntime() {
	const root = await mkdtemp(join(tmpdir(), "bear-character-draft-"));
	roots.push(root);
	const runtime = new HostRuntime({
		dataDir: join(root, "data"),
		characterSeedRoot: characterRoot,
		productConfig: { defaultCharacterId: "jizhou" },
	});
	await runtime.start();
	return runtime;
}

async function packageAsDraftFiles(
	root: string,
	directory = root,
): Promise<Record<string, { encoding: "base64"; content: string }>> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: Record<string, { encoding: "base64"; content: string }> = {};
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) Object.assign(files, await packageAsDraftFiles(root, path));
		else
			files[relative(root, path)] = {
				encoding: "base64",
				content: (await readFile(path)).toString("base64"),
			};
	}
	return files;
}

describe("character package drafts", () => {
	it("creates immutable file revisions and returns only the protocol draft projection", async () => {
		const runtime = await createRuntime();
		try {
			const created = await runtime.dispatch("character.draftCreate:v1", { locale: "zh-CN" });
			expect(created).toMatchObject({
				ok: true,
				data: { draft: { status: "draft", locale: "zh-CN", currentRevision: 1, files: {} } },
			});
			const draftId = created.data.draft.id;

			const firstPatch = await runtime.dispatch("character.draftPatch:v1", {
				id: draftId,
				expectedRevision: 1,
				files: {
					"character.yaml": { encoding: "utf8", content: "id: atelier-test\n" },
					"locales/zh-CN.yaml": { encoding: "utf8", content: "name: 测试\n" },
				},
			});
			expect(firstPatch.data.draft).toMatchObject({
				currentRevision: 2,
				files: {
					"character.yaml": { encoding: "utf8", content: "id: atelier-test\n" },
					"locales/zh-CN.yaml": { encoding: "utf8", content: "name: 测试\n" },
				},
			});

			const secondPatch = await runtime.dispatch("character.draftPatch:v1", {
				id: draftId,
				expectedRevision: 2,
				files: {
					"character.yaml": { encoding: "utf8", content: "id: atelier-test\n" },
				},
			});
			expect(secondPatch.data.draft).toMatchObject({
				currentRevision: 3,
				files: {
					"character.yaml": { encoding: "utf8", content: "id: atelier-test\n" },
					"locales/zh-CN.yaml": { encoding: "utf8", content: "name: 测试\n" },
				},
			});

			const fetched = await runtime.dispatch("character.draftGet:v1", { id: draftId });
			expect(fetched.data.draft).toEqual(secondPatch.data.draft);
		} finally {
			await runtime.close();
		}
	});

	it("rejects a stale validation request before it can inspect or publish a newer revision", async () => {
		const runtime = await createRuntime();
		try {
			const created = await runtime.dispatch("character.draftCreate:v1", {});
			const draftId = created.data.draft.id;
			const patched = await runtime.dispatch("character.draftPatch:v1", {
				id: draftId,
				expectedRevision: 1,
				files: {
					"character.yaml": { encoding: "utf8", content: "id: incomplete-workshop-package\n" },
				},
			});
			await expect(
				runtime.dispatch("character.draftValidate:v1", {
					id: draftId,
					expectedRevision: 1,
				}),
			).resolves.toMatchObject({
				ok: false,
				error: { kind: "conflict", reason: "character_draft_revision_mismatch" },
			});
			await expect(
				runtime.dispatch("character.draftValidate:v1", {
					id: draftId,
					expectedRevision: patched.data.draft.currentRevision,
				}),
			).resolves.toMatchObject({ ok: false, error: { kind: "invalid_request" } });
			await expect(
				runtime.dispatch("character.draftGet:v1", { id: draftId }),
			).resolves.toMatchObject({
				data: { draft: { status: "draft", currentRevision: 2 } },
			});
		} finally {
			await runtime.close();
		}
	});

	it("accepts image uploads directly and preserves their source bytes in the next revision", async () => {
		const runtime = await createRuntime();
		try {
			const created = await runtime.dispatch("character.draftCreate:v1", {});
			const avatar = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString("base64");
			await expect(
				runtime.dispatch("character.draftUploadAssets:v1", {
					id: created.data.draft.id,
					expectedRevision: 1,
					assets: [{ path: "assets/avatar.png", mime: "image/png", base64: avatar }],
				}),
			).resolves.toMatchObject({
				ok: true,
				data: {
					draft: {
						currentRevision: 2,
						files: { "assets/avatar.png": { encoding: "base64", content: avatar } },
					},
				},
			});
			await expect(
				runtime.dispatch("character.draftUploadAssets:v1", {
					id: created.data.draft.id,
					expectedRevision: 1,
					assets: [{ path: "assets/again.png", mime: "image/png", base64: avatar }],
				}),
			).resolves.toMatchObject({
				ok: false,
				error: { kind: "conflict", reason: "character_draft_revision_mismatch" },
			});
		} finally {
			await runtime.close();
		}
	});

	it("restores an old revision by appending a new immutable revision", async () => {
		const runtime = await createRuntime();
		try {
			const created = await runtime.dispatch("character.draftCreate:v1", {});
			const first = await runtime.dispatch("character.draftPatch:v1", {
				id: created.data.draft.id,
				expectedRevision: 1,
				files: { "notes.txt": { encoding: "utf8", content: "first" } },
			});
			const second = await runtime.dispatch("character.draftPatch:v1", {
				id: created.data.draft.id,
				expectedRevision: first.data.draft.currentRevision,
				files: { "notes.txt": { encoding: "utf8", content: "second" } },
			});
			await expect(
				runtime.dispatch("character.draftRestoreRevision:v1", {
					id: created.data.draft.id,
					expectedRevision: second.data.draft.currentRevision,
					sourceRevision: first.data.draft.currentRevision,
				}),
			).resolves.toMatchObject({
				ok: true,
				data: {
					draft: {
						status: "draft",
						currentRevision: 4,
						files: { "notes.txt": { encoding: "utf8", content: "first" } },
					},
				},
			});
			await expect(
				runtime.dispatch("character.draftListRevisions:v1", { id: created.data.draft.id }),
			).resolves.toMatchObject({
				ok: true,
				data: { revisions: [{ revision: 4 }, { revision: 3 }, { revision: 2 }, { revision: 1 }] },
			});
		} finally {
			await runtime.close();
		}
	});

	it("validates and publishes a binary-safe package revision, then activates that character", async () => {
		const runtime = await createRuntime();
		try {
			const created = await runtime.dispatch("character.draftCreate:v1", {
				basePackageId: "jizhou",
			});
			const files = await packageAsDraftFiles(join(characterRoot, "jizhou"));
			const manifest = files["character.yaml"];
			if (!manifest) throw new Error("fixture character manifest missing");
			manifest.content = Buffer.from(
				Buffer.from(manifest.content, "base64")
					.toString("utf8")
					.replace("id: jizhou", "id: workshop-published"),
			).toString("base64");
			const patched = await runtime.dispatch("character.draftPatch:v1", {
				id: created.data.draft.id,
				expectedRevision: 1,
				files,
			});
			const revision = patched.data.draft.currentRevision;
			await expect(
				runtime.dispatch("character.draftValidate:v1", {
					id: created.data.draft.id,
					expectedRevision: revision,
				}),
			).resolves.toMatchObject({ ok: true, data: { draft: { status: "ready_to_publish" } } });
			await expect(
				runtime.dispatch("character.draftPublish:v1", {
					id: created.data.draft.id,
					expectedRevision: revision,
				}),
			).resolves.toMatchObject({
				ok: true,
				data: { draft: { status: "published" }, character: { id: "workshop-published" } },
			});
			await expect(runtime.dispatch("character.get:v1", {})).resolves.toMatchObject({
				data: { character: { id: "workshop-published" } },
			});
		} finally {
			await runtime.close();
		}
	});
});
