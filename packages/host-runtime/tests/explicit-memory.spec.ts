import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExplicitMemoryFile } from "../src/memory/explicit-memory.js";

describe("ExplicitMemoryFile", () => {
	it("stores exact user-authorized text without creating a second memory model", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-explicit-memory-"));
		const memory = new ExplicitMemoryFile(root, "user-a", "role-a");
		expect(await memory.read()).toBe("");
		expect(await memory.edit(undefined, "- 用户不吃香菜。")).toBe("- 用户不吃香菜。\n");
		expect(await memory.edit("不吃香菜", "不吃芹菜")).toBe("- 用户不吃芹菜。\n");
		expect(await readFile(memory.path, "utf8")).toBe("- 用户不吃芹菜。\n");
	});

	it("rejects ambiguous edits and oversized documents", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-explicit-memory-"));
		const memory = new ExplicitMemoryFile(root, "user-a", "role-a");
		await memory.edit(undefined, "same same");
		await expect(memory.edit("same", "new")).rejects.toThrow(/more than once/);
		await expect(memory.edit(undefined, "x".repeat(4001))).rejects.toThrow(/exceeds/);
	});

	it("serializes asynchronous edits across instances without leaving lock files", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-explicit-memory-"));
		const first = new ExplicitMemoryFile(root, "user-a", "role-a");
		const second = new ExplicitMemoryFile(root, "user-a", "role-a");
		await Promise.all([
			first.edit(undefined, "- first fact"),
			second.edit(undefined, "- second fact"),
		]);
		const content = await first.read();
		expect(content).toContain("- first fact");
		expect(content).toContain("- second fact");
		expect(await readdir(join(root, "companions", "role-a", "memory"))).toEqual(["MEMORY.md"]);
	});

	it("syncs the memory directory after the atomic replacement", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-explicit-memory-"));
		let memory: ExplicitMemoryFile;
		const observations: string[] = [];
		memory = new ExplicitMemoryFile(root, "user-a", "role-a", {
			syncDirectory: async (directory) => {
				observations.push(directory);
				expect(await readFile(memory.path, "utf8")).toBe("durable fact\n");
				expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
			},
		});

		await expect(memory.edit(undefined, "durable fact")).resolves.toBe("durable fact\n");
		expect(observations).toEqual([dirname(memory.path)]);
	});

	it("reports directory sync failure after rename and still releases cleanup resources", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-explicit-memory-"));
		let attempts = 0;
		const memory = new ExplicitMemoryFile(root, "user-a", "role-a", {
			syncDirectory: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("directory sync failed");
			},
		});

		await expect(memory.edit(undefined, "committed before sync")).rejects.toThrow(
			"directory sync failed",
		);
		expect(await memory.read()).toBe("committed before sync\n");
		await expect(memory.edit("committed", "durable")).resolves.toBe("durable before sync\n");
		expect(await readdir(dirname(memory.path))).toEqual(["MEMORY.md"]);
	});

	it("rejects unsafe storage scope components", () => {
		const root = join(tmpdir(), "bear-explicit-memory-scope");
		expect(() => new ExplicitMemoryFile(root, "..", "role-a")).toThrow(/safe path/);
		expect(() => new ExplicitMemoryFile(root, "user-a", "../role-a")).toThrow(/safe path/);
	});
});
