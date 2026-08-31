// @vitest-environment node

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import type { PiRuntime } from "../src/companion/pi-runtime.js";
import { SessionCatalog } from "../src/companion/session-catalog.js";
import { COMPANION_MIGRATIONS, CompanionDatabase } from "../src/storage/database.js";
import {
	artifactAdoptions,
	artifacts,
	canonSources,
	conversations,
	evidence,
	runManifests,
	runs,
} from "../src/storage/schema.js";

const roots: string[] = [];

function root() {
	const value = mkdtempSync(join(tmpdir(), "bear-session-catalog-"));
	roots.push(value);
	return value;
}

function session(directory: string, id: string, name: string, modified: string) {
	const path = join(directory, `${id}.jsonl`);
	writeFileSync(path, "{}\n");
	return {
		path,
		id,
		cwd: directory,
		name,
		created: new Date("2026-01-01T00:00:00.000Z"),
		modified: new Date(modified),
		messageCount: 2,
		firstMessage: "first user message",
		allMessagesText: "first user message assistant answer",
	};
}

function setup() {
	const directory = root();
	const database = new CompanionDatabase(join(directory, "runtime.db"), "bear");
	database.migrate(COMPANION_MIGRATIONS);
	database.ensureRuntimeIdentity();
	const sessions = [
		session(directory, "alpha", "Find Release Bugs", "2026-01-03T00:00:00.000Z"),
		session(directory, "beta", "Plan Autumn Trip", "2026-01-02T00:00:00.000Z"),
		session(directory, "other", "Other Character", "2026-01-04T00:00:00.000Z"),
	];
	const pi = {
		list: vi.fn(async () => sessions),
		create: vi.fn(),
		open: vi.fn(async (id: string) => ({ sessionId: id })),
		rename: vi.fn(),
		fork: vi.fn(),
		snapshot: vi.fn(() => undefined),
		close: vi.fn(async () => undefined),
		delete: vi.fn(async (_id: string, remove: () => void | Promise<void>) => remove()),
	} as unknown as PiRuntime;
	const artifactStore = new ArtifactStore(database.orm, join(directory, "artifacts"));
	const beforeDelete = vi.fn(async () => undefined);
	const catalog = new SessionCatalog(database.orm, pi, {
		beforeDelete,
		artifacts: artifactStore,
	});
	database.orm
		.insert(conversations)
		.values([
			{ id: "alpha", companionId: "bear" },
			{ id: "beta", companionId: "bear" },
		])
		.run();
	return { artifactStore, beforeDelete, catalog, database, pi, sessions };
}

afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SessionCatalog", () => {
	it("adds ownership before Pi opens a new session", async () => {
		const { catalog, database, pi } = setup();
		try {
			vi.mocked(pi.create).mockImplementation(async (_title, beforeOpen) => {
				beforeOpen?.("new-session");
				return { sessionId: "new-session" } as never;
			});
			await catalog.create("bear");
			expect(
				database.connection
					.prepare("SELECT companion_id FROM conversations WHERE id = 'new-session'")
					.get(),
			).toEqual({ companion_id: "bear" });
		} finally {
			database.close();
		}
	});

	it("removes the ownership row when Pi cannot open the new session", async () => {
		const { catalog, database, pi } = setup();
		try {
			vi.mocked(pi.create).mockImplementation(async (_title, beforeOpen) => {
				beforeOpen?.("failed-session");
				throw new Error("model unavailable");
			});
			await expect(catalog.create("bear")).rejects.toThrow("model unavailable");
			expect(
				database.connection
					.prepare("SELECT id FROM conversations WHERE id = 'failed-session'")
					.get(),
			).toBeUndefined();
		} finally {
			database.close();
		}
	});

	it("lists only the companion's Pi sessions in Pi modification order", async () => {
		const { catalog, database } = setup();
		try {
			expect((await catalog.list("bear")).map(({ id }) => id)).toEqual(["alpha", "beta"]);
		} finally {
			database.close();
		}
	});

	it("passes WorkBuddy-style title words through the total-session listing", async () => {
		const { catalog, database } = setup();
		try {
			expect((await catalog.list("bear", { title: "release BUG" })).map(({ id }) => id)).toEqual([
				"alpha",
			]);
			expect(await catalog.list("bear", { title: "assistant answer" })).toEqual([]);
		} finally {
			database.close();
		}
	});

	it("keeps archived sessions out of the default listing", async () => {
		const { catalog, database } = setup();
		try {
			await catalog.archive("bear", "beta", true);
			expect((await catalog.list("bear")).map(({ id }) => id)).toEqual(["alpha"]);
			expect((await catalog.list("bear", { archived: true })).map(({ id }) => id)).toEqual([
				"beta",
			]);
		} finally {
			database.close();
		}
	});

	it("closes only the archived session without inventing a replacement", async () => {
		const { catalog, database, pi } = setup();
		try {
			expect(await catalog.archive("bear", "alpha", true)).toBeUndefined();
			expect(pi.close).toHaveBeenCalledOnce();
			expect(pi.close).toHaveBeenCalledWith("alpha");
			expect(pi.delete).not.toHaveBeenCalled();
			expect(pi.create).not.toHaveBeenCalled();
			expect(pi.open).not.toHaveBeenCalled();
		} finally {
			database.close();
		}
	});

	it("deletes the owned Pi session file and does not open another session", async () => {
		const { beforeDelete, catalog, database, pi, sessions } = setup();
		try {
			const alpha = sessions[0];
			if (!alpha) throw new Error("missing alpha fixture");
			expect(await catalog.delete("bear", "alpha")).toBeUndefined();
			expect(pi.delete).toHaveBeenCalledOnce();
			expect(pi.delete).toHaveBeenCalledWith("alpha", expect.any(Function));
			expect(vi.mocked(pi.delete).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(pi.list).mock.invocationCallOrder[0] ?? 0,
			);
			expect(beforeDelete).toHaveBeenCalledWith("alpha");
			expect(pi.create).not.toHaveBeenCalled();
			expect(pi.open).not.toHaveBeenCalled();
			expect(existsSync(alpha.path)).toBe(false);
			expect(
				database.connection.prepare("SELECT id FROM conversations WHERE id = 'alpha'").get(),
			).toBeUndefined();
		} finally {
			database.close();
		}
	});

	it("purges CAS bytes only after the final artifact hash reference is deleted", async () => {
		const { artifactStore, catalog, database } = setup();
		try {
			for (const [id, conversationId] of [
				["run-alpha", "alpha"],
				["run-beta", "beta"],
			] as const) {
				database.orm
					.insert(runs)
					.values({
						id,
						conversationId,
						triggerEntryId: `entry-${id}`,
						executorProfile: "pi-default",
						title: id,
						instruction: "Work",
						status: "completed",
						completedAt: "2026-08-31T00:00:00.000Z",
					})
					.run();
			}
			const buffer = Buffer.from("shared result");
			const first = artifactStore.create({
				logicalName: "alpha.txt",
				buffer,
				mime: "text/plain",
				producerRunId: "run-alpha",
			});
			artifactStore.create({
				logicalName: "beta.txt",
				buffer,
				mime: "text/plain",
				producerRunId: "run-beta",
			});
			const casPath = join(artifactStore.directory, first.sha256);

			await catalog.delete("bear", "alpha");
			expect(existsSync(casPath)).toBe(true);

			await catalog.delete("bear", "beta");
			expect(existsSync(casPath)).toBe(false);
		} finally {
			database.close();
		}
	});

	it("atomically removes Run-owned rows before deleting a conversation", async () => {
		const { catalog, database } = setup();
		try {
			database.orm
				.insert(runs)
				.values({
					id: "run-alpha",
					conversationId: "alpha",
					triggerEntryId: "entry-alpha",
					executorProfile: "pi-default",
					title: "Run",
					instruction: "Work",
				})
				.run();
			database.orm.insert(runManifests).values({ id: "manifest-alpha", runId: "run-alpha" }).run();
			database.orm
				.insert(evidence)
				.values({ id: "evidence-alpha", runId: "run-alpha", kind: "result" })
				.run();
			database.orm
				.insert(artifacts)
				.values({
					id: "artifact-alpha",
					logicalName: "result.txt",
					mime: "text/plain",
					bytes: 6,
					sha256: "a".repeat(64),
					producerRunId: "run-alpha",
				})
				.run();
			database.orm
				.insert(artifactAdoptions)
				.values({ id: "adoption-alpha", artifactId: "artifact-alpha", runId: "run-alpha" })
				.run();
			database.orm
				.insert(canonSources)
				.values({
					id: "canon-alpha",
					companionId: "bear",
					logicalName: "result.txt",
					mime: "text/plain",
					sha256: "a".repeat(64),
					artifactId: "artifact-alpha",
				})
				.run();

			await catalog.delete("bear", "alpha");

			expect(database.orm.select().from(runs).all()).toEqual([]);
			expect(database.orm.select().from(runManifests).all()).toEqual([]);
			expect(database.orm.select().from(evidence).all()).toEqual([]);
			expect(database.orm.select().from(artifacts).all()).toEqual([]);
			expect(database.orm.select().from(artifactAdoptions).all()).toEqual([]);
			expect(database.orm.select().from(canonSources).get()?.artifactId).toBeNull();
		} finally {
			database.close();
		}
	});

	it("treats repeated deletion as success", async () => {
		const { catalog, database, pi } = setup();
		try {
			await catalog.delete("bear", "alpha");
			await expect(catalog.delete("bear", "alpha")).resolves.toBeUndefined();
			expect(pi.delete).toHaveBeenCalledTimes(1);
		} finally {
			database.close();
		}
	});

	it("treats a Pi session outside this physical Catalog as absent without deleting it", async () => {
		const { catalog, database, pi, sessions } = setup();
		try {
			const other = sessions[2];
			if (!other) throw new Error("missing other fixture");
			await expect(catalog.delete("bear", "other")).resolves.toBeUndefined();
			expect(pi.delete).not.toHaveBeenCalled();
			expect(existsSync(other.path)).toBe(true);
		} finally {
			database.close();
		}
	});

	it("rejects cross-companion opening before calling Pi", async () => {
		const { catalog, database, pi } = setup();
		try {
			await expect(catalog.open("bear", "other")).rejects.toMatchObject({
				kind: "not_found",
				reason: "conversation_not_found",
			});
			expect(pi.open).not.toHaveBeenCalled();
		} finally {
			database.close();
		}
	});

	it("renames an owned Pi session without opening it", async () => {
		const { catalog, database, pi } = setup();
		try {
			await catalog.rename("bear", "beta", "Autumn route");
			expect(pi.open).not.toHaveBeenCalled();
			expect(pi.rename).toHaveBeenCalledWith("beta", "Autumn route");
		} finally {
			database.close();
		}
	});
});
