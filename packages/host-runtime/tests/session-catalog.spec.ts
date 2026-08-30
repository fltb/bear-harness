// @vitest-environment node

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiRuntime } from "../src/companion/pi-runtime.js";
import { SessionCatalog } from "../src/companion/session-catalog.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { companionIdentity, companionPackages, conversations } from "../src/storage/schema.js";

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
	const database = new Database(join(directory, "database"));
	database.migrate(MIGRATIONS);
	const sessions = [
		session(directory, "alpha", "Find Release Bugs", "2026-01-03T00:00:00.000Z"),
		session(directory, "beta", "Plan Autumn Trip", "2026-01-02T00:00:00.000Z"),
		session(directory, "other", "Other Character", "2026-01-04T00:00:00.000Z"),
	];
	let active = "alpha";
	const pi = {
		list: vi.fn(async () => sessions),
		create: vi.fn(),
		select: vi.fn(async (id: string) => ({ sessionId: id })),
		setName: vi.fn(),
		fork: vi.fn(),
		snapshot: vi.fn(() => (active ? { sessionId: active } : undefined)),
		close: vi.fn(async () => {
			active = "";
		}),
	} as unknown as PiRuntime;
	const catalog = new SessionCatalog(database.orm, pi);
	database.orm
		.insert(companionPackages)
		.values({ id: "test-package", name: "Test", version: "1", hash: "test" })
		.run();
	database.orm
		.insert(companionIdentity)
		.values([
			{ id: "bear", packageId: "test-package", name: "Bear" },
			{ id: "fox", packageId: "test-package", name: "Fox" },
		])
		.run();
	database.orm
		.insert(conversations)
		.values([
			{ id: "alpha", companionId: "bear" },
			{ id: "beta", companionId: "bear" },
			{ id: "other", companionId: "fox" },
		])
		.run();
	return { catalog, database, pi, sessions };
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

	it("closes an archived active session without inventing a replacement", async () => {
		const { catalog, database, pi } = setup();
		try {
			expect(await catalog.archive("bear", "alpha", true)).toBeUndefined();
			expect(pi.close).toHaveBeenCalledOnce();
			expect(pi.create).not.toHaveBeenCalled();
			expect(pi.select).not.toHaveBeenCalled();
		} finally {
			database.close();
		}
	});

	it("deletes the owned Pi session file and does not select another session", async () => {
		const { catalog, database, pi, sessions } = setup();
		try {
			expect(await catalog.delete("bear", "alpha")).toBeUndefined();
			expect(pi.close).toHaveBeenCalledOnce();
			expect(pi.create).not.toHaveBeenCalled();
			expect(pi.select).not.toHaveBeenCalled();
			expect(existsSync(sessions[0]!.path)).toBe(false);
		} finally {
			database.close();
		}
	});

	it("rejects cross-companion selection before calling Pi", async () => {
		const { catalog, database, pi } = setup();
		try {
			await expect(catalog.select("bear", "other")).rejects.toMatchObject({
				kind: "not_found",
				reason: "conversation_not_found",
			});
			expect(pi.select).not.toHaveBeenCalled();
		} finally {
			database.close();
		}
	});

	it("renames only after selecting an owned Pi session", async () => {
		const { catalog, database, pi } = setup();
		try {
			await catalog.rename("bear", "beta", "Autumn route");
			expect(pi.select).toHaveBeenCalledWith("beta");
			expect(pi.setName).toHaveBeenCalledWith("Autumn route");
		} finally {
			database.close();
		}
	});
});
