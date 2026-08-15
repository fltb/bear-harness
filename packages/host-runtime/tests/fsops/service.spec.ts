// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileOpsService, guardCell } from "../../src/fsops/service.js";
import { Database, MIGRATIONS } from "../../src/storage/database.js";
import { EventBus } from "../../src/storage/event-bus.js";

describe("FileOpsService user file workflow", () => {
	let root: string;
	let database: Database;
	let service: FileOpsService;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-fsops-"));
		database = new Database(join(root, "database"));
		database.migrate(MIGRATIONS);
		service = new FileOpsService(database.connection, new EventBus(database.connection));
	});

	afterEach(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("plans, executes, journals, and reverses common file operations", async () => {
		const source = join(root, "source.txt");
		const copy = join(root, "nested", "copy.txt");
		const created = join(root, "created.txt");
		const moved = join(root, "moved.txt");
		const directory = join(root, "empty-directory");
		writeFileSync(source, "source-content");
		const plan = service.plan({
			authorizedRoots: [root],
			ops: [
				{ kind: "create", dst: created, contentBase64: Buffer.from("created").toString("base64") },
				{ kind: "write_new", src: source, dst: copy },
				{ kind: "rename", src: source, dst: moved },
				{ kind: "mkdir", dst: directory },
			],
		});
		const result = await service.execute(plan.id);
		expect(result.errors).toEqual([]);
		expect(result.journal.map((entry) => entry.status)).toEqual(["done", "done", "done", "done"]);
		expect(readFileSync(created, "utf8")).toBe("created");
		expect(readFileSync(copy, "utf8")).toBe("source-content");
		expect(readFileSync(moved, "utf8")).toBe("source-content");

		const firstJournal = result.journal[0];
		if (!firstJournal) throw new Error("expected file operation journal");
		const undone = service.undo(firstJournal.id);
		expect(undone.map((entry) => entry.status)).toEqual(["undone", "undone", "undone", "undone"]);
		expect(readFileSync(source, "utf8")).toBe("source-content");
		expect(() => readFileSync(created)).toThrow();
		expect(() => readFileSync(copy)).toThrow();
	});

	it("does not overwrite a destination changed after planning", async () => {
		const destination = join(root, "destination.txt");
		writeFileSync(destination, "before");
		const plan = service.plan({
			authorizedRoots: [root],
			ops: [
				{
					kind: "create",
					dst: destination,
					contentBase64: Buffer.from("planned").toString("base64"),
				},
			],
		});
		writeFileSync(destination, "changed-after-plan-and-longer");
		const result = await service.execute(plan.id);
		expect(result.journal).toEqual([
			expect.objectContaining({ status: "needs_user", error: "conflict_dst_changed" }),
		]);
		expect(readFileSync(destination, "utf8")).toBe("changed-after-plan-and-longer");
	});

	it("refuses traversal, paths outside approved roots, and symlink escapes", () => {
		const outside = mkdtempSync(join(tmpdir(), "bear-fsops-outside-"));
		try {
			const link = join(root, "escape");
			symlinkSync(outside, link, "dir");
			expect(() => service.plan({ authorizedRoots: [], ops: [] })).toThrow(
				expect.objectContaining({ reason: "no_authorized_roots" }),
			);
			expect(() =>
				service.plan({
					authorizedRoots: [root],
					ops: [{ kind: "create", dst: `${root}/../escaped.txt` }],
				}),
			).toThrow(expect.objectContaining({ reason: "path_traversal" }));
			expect(() =>
				service.plan({
					authorizedRoots: [root],
					ops: [{ kind: "create", dst: join(link, "escaped.txt") }],
				}),
			).toThrow(expect.objectContaining({ reason: "symlink_escape" }));
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("stops after verification failure and leaves an auditable error", async () => {
		const destination = join(root, "wrong-hash.txt");
		const skipped = join(root, "skipped.txt");
		const plan = service.plan({
			authorizedRoots: [root],
			ops: [
				{ kind: "create", dst: destination, contentHash: "not-the-real-hash" },
				{ kind: "create", dst: skipped },
			],
		});
		const result = await service.execute(plan.id);
		expect(result.journal).toHaveLength(1);
		expect(result.errors[0]).toContain("content_hash_mismatch");
		expect(() => readFileSync(skipped)).toThrow();
		await expect(service.execute("missing-plan")).rejects.toMatchObject({
			reason: "plan_not_found",
		});
		expect(() => service.undo("missing-journal")).toThrow(
			expect.objectContaining({ reason: "journal_not_found" }),
		);
	});

	it("guards spreadsheet-like output from formula execution", () => {
		expect(["=SUM(A1:A2)", "+cmd", "-1", "@name", "plain"].map(guardCell)).toEqual([
			"'=SUM(A1:A2)",
			"'+cmd",
			"'-1",
			"'@name",
			"plain",
		]);
	});
});
