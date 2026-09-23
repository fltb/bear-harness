import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import { VectorStore } from "../../tdai-core/src/core/store/sqlite.js";
import { type CredentialVault, createHostRuntime, type HostRuntime } from "../src/index.js";
import { ExplicitMemoryFile } from "../src/memory/explicit-memory.js";
import { RuntimeLayout } from "../src/storage/layout.js";

const seedRoot = fileURLToPath(new URL("./fixtures/characters", import.meta.url));
const vault: CredentialVault = {
	securityLevel: "session",
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};
const opened: Array<{ runtime: HostRuntime; root: string }> = [];

afterEach(async () => {
	for (const { runtime, root } of opened.splice(0)) {
		await runtime.close();
		rmSync(root, { recursive: true, force: true });
	}
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "bear-memory-inspection-"));
	const otherPackage = join(root, "characters", "other");
	mkdirSync(join(root, "characters"), { recursive: true });
	cpSync(join(seedRoot, "jizhou"), otherPackage, { recursive: true });
	const yaml = join(otherPackage, "character.yaml");
	writeFileSync(yaml, readFileSync(yaml, "utf8").replace("id: jizhou", "id: other"));
	const runtime = createHostRuntime({
		dataDir: root,
		characterSeedRoot: seedRoot,
		productConfig,
		credentialVault: vault,
	});
	opened.push({ runtime, root });
	const layout = new RuntimeLayout(root);
	return { root, runtime, layout };
}

function seedRecords(directory: string, contents: string[]) {
	const store = new VectorStore(join(directory, "vectors.db"), 0);
	store.init();
	try {
		for (const [index, content] of contents.entries()) {
			store.upsertL1(
				{
					id: `record-${index}`,
					content,
					type: "persona",
					priority: 50,
					scene_name: "日常",
					source_message_ids: [],
					metadata: {},
					timestamps: [],
					createdAt: "2026-09-13T00:00:00.000Z",
					updatedAt: "2026-09-13T00:00:00.000Z",
					sessionKey: "local-character",
					sessionId: `session-${index}`,
				},
				undefined,
			);
		}
	} finally {
		store.close();
	}
}

describe("character memory inspection", () => {
	it("reads an inactive character's actual memories without selecting it or mixing same-id records", async () => {
		const { runtime, root, layout } = setup();
		const first = layout.ensureCompanionDirectories("jizhou");
		const second = layout.ensureCompanionDirectories("other");
		seedRecords(first.tdaiMemory, ["第一位角色：喜欢热茶"]);
		seedRecords(second.tdaiMemory, ["第二位角色：喜欢冷咖啡"]);
		await new ExplicitMemoryFile(root, "user", "jizhou").edit(undefined, "第一位角色的明确约定");
		await new ExplicitMemoryFile(root, "user", "other").edit(undefined, "第二位角色的明确约定");
		const before = await runtime.dispatch("character.get", { characterId: "jizhou" });
		const records = await runtime.dispatch("memory.inspect", { characterId: "other" });
		expect(records).toMatchObject({
			ok: true,
			data: {
				characterId: "other",
				relationshipMemoryEnabled: false,
				items: [{ id: "record-0", content: "第二位角色：喜欢冷咖啡", sessionId: "session-0" }],
			},
		});
		expect(await runtime.dispatch("memory.inspect", { characterId: "jizhou" })).toMatchObject({
			ok: true,
			data: { items: [{ content: "第一位角色：喜欢热茶" }] },
		});
		expect(
			await runtime.dispatch("memory.inspect", { characterId: "other", kind: "explicit" }),
		).toMatchObject({
			ok: true,
			data: { characterId: "other", explicit: "第二位角色的明确约定\n" },
		});
		expect(await runtime.dispatch("character.get", { characterId: "jizhou" })).toEqual(before);
	});

	it("paginates tied record timestamps and scene profiles without dropping entries", async () => {
		const { runtime, layout } = setup();
		const paths = layout.ensureCompanionDirectories("jizhou");
		seedRecords(paths.tdaiMemory, ["旧条目", "新条目"]);
		expect(
			await runtime.dispatch("memory.inspect", { characterId: "jizhou", limit: 1 }),
		).toMatchObject({
			ok: true,
			data: { items: [{ content: "新条目" }], nextOffset: 1 },
		});
		const last = await runtime.dispatch("memory.inspect", {
			characterId: "jizhou",
			offset: 1,
			limit: 1,
		});
		expect(last).toMatchObject({ ok: true, data: { items: [{ content: "旧条目" }] } });
		expect(last.ok && Object.hasOwn(last.data as object, "nextOffset")).toBe(false);
		mkdirSync(join(paths.tdaiMemory, "scene_blocks"), { recursive: true });
		writeFileSync(join(paths.tdaiMemory, "scene_blocks", "日常.md"), "# 日常\n一起喝茶。");
		writeFileSync(join(paths.tdaiMemory, "persona.md"), "# 画像\n偏爱安静的交谈。");
		expect(
			await runtime.dispatch("memory.inspect", {
				characterId: "jizhou",
				kind: "profiles",
				limit: 1,
			}),
		).toMatchObject({
			ok: true,
			data: { items: [{ type: "l2", content: "# 日常\n一起喝茶。" }], nextOffset: 1 },
		});
		expect(
			await runtime.dispatch("memory.inspect", {
				characterId: "jizhou",
				kind: "profiles",
				offset: 1,
				limit: 1,
			}),
		).toMatchObject({
			ok: true,
			data: { items: [{ type: "l3", content: "# 画像\n偏爱安静的交谈。" }] },
		});
	});

	it("keeps explicit and automatic memory readable independently when the other domain is damaged", async () => {
		const { runtime, layout, root } = setup();
		const paths = layout.ensureCompanionDirectories("jizhou");
		seedRecords(paths.tdaiMemory, ["完整的自动记忆"]);
		writeFileSync(paths.explicitMemory, "x".repeat(4001));
		expect(await runtime.dispatch("memory.inspect", { characterId: "jizhou" })).toMatchObject({
			ok: true,
			data: { items: [{ content: "完整的自动记忆" }] },
		});
		expect(
			await runtime.dispatch("memory.inspect", { characterId: "jizhou", kind: "explicit" }),
		).toMatchObject({ ok: false });
		rmSync(paths.explicitMemory);
		await new ExplicitMemoryFile(root, "user", "jizhou").edit(undefined, "完整的显式记忆");
		writeFileSync(join(paths.tdaiMemory, "vectors.db"), "not a database");
		expect(await runtime.dispatch("memory.inspect", { characterId: "jizhou" })).toMatchObject({
			ok: false,
		});
		expect(
			await runtime.dispatch("memory.inspect", { characterId: "jizhou", kind: "explicit" }),
		).toMatchObject({
			ok: true,
			data: { explicit: "完整的显式记忆\n" },
		});
	});

	it("rejects cross-character symlinks and unknown ownership instead of returning foreign content", async () => {
		const { runtime, layout, root } = setup();
		const paths = layout.ensureCompanionDirectories("jizhou");
		const other = layout.ensureCompanionDirectories("other");
		seedRecords(other.tdaiMemory, ["另一位角色的秘密"]);
		await new ExplicitMemoryFile(root, "user", "other").edit(undefined, "另一位角色的明确记忆");
		symlinkSync(other.explicitMemory, paths.explicitMemory);
		symlinkSync(join(other.tdaiMemory, "vectors.db"), join(paths.tdaiMemory, "vectors.db"));
		expect(
			await runtime.dispatch("memory.inspect", { characterId: "jizhou", kind: "explicit" }),
		).toMatchObject({ ok: false });
		expect(await runtime.dispatch("memory.inspect", { characterId: "jizhou" })).toMatchObject({
			ok: false,
		});
		symlinkSync(other.tdaiMemory, join(paths.tdaiMemory, "scene_blocks"));
		expect(
			await runtime.dispatch("memory.inspect", { characterId: "jizhou", kind: "profiles" }),
		).toMatchObject({ ok: false });
		expect(
			await runtime.dispatch("memory.inspect", { characterId: "unknown-character" }),
		).toMatchObject({ ok: false });
		expect(existsSync(join(root, "companions", "unknown-character"))).toBe(false);
	});

	it("does not start the automatic memory store when reading empty memory", async () => {
		const { runtime, layout } = setup();
		expect(await runtime.dispatch("memory.inspect", { characterId: "other" })).toMatchObject({
			ok: true,
			data: { characterId: "other", items: [] },
		});
		expect(existsSync(join(layout.companion("other").tdaiMemory, "vectors.db"))).toBe(false);
		expect(await runtime.dispatch("memory.inspect", { characterId: "jizhou" })).toMatchObject({
			ok: true,
			data: { items: [] },
		});
		expect(
			existsSync(join(layout.ensureCompanionDirectories("jizhou").tdaiMemory, "vectors.db")),
		).toBe(false);
	});
});
