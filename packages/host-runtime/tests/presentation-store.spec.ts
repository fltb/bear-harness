// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryPresentationStore, type MemoryPresentationScope } from "../src/memory/presentation-store.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";

const roots: string[] = [];
const databases: Database[] = [];

function openDatabase(): Database {
    const root = mkdtempSync(join(tmpdir(), "bear-memory-presentation-"));
    roots.push(root);
    const database = new Database(root);
    database.migrate(MIGRATIONS);
    database.connection
        .prepare("INSERT INTO companion_packages (id, name, version, hash) VALUES (?, ?, ?, ?)")
        .run("package-a", "Test Companion", "1.0.0", "test-hash");
    database.connection
        .prepare("INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)")
        .run("companion-a", "package-a", "Test Companion", "");
    databases.push(database);
    return database;
}

const scopeA: MemoryPresentationScope = {
    installationId: "installation-a",
    userId: "user-a",
    companionId: "companion-a",
};

const scopeB: MemoryPresentationScope = {
    installationId: "installation-b",
    userId: "user-a",
    companionId: "companion-a",
};

afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MemoryPresentationStore", () => {
    it("keeps metadata isolated by the complete memory scope", () => {
        const database = openDatabase();
        const store = new MemoryPresentationStore(database.orm);

        store.recordDirectCreation(scopeA, {
            backendMemoryId: "backend-1",
            sourcePiEntryId: "pi-entry-a",
            createdBy: "user_capture",
        });
        store.recordDirectCreation(scopeB, {
            backendMemoryId: "backend-1",
            sourcePiEntryId: "pi-entry-b",
            createdBy: "assistant_tool",
        });

        expect(store.get(scopeA, "backend-1")).toMatchObject({
            backendMemoryId: "backend-1",
            sourcePiEntryId: "pi-entry-a",
            createdBy: "user_capture",
            pinned: false,
        });
        expect(store.get(scopeB, "backend-1")).toMatchObject({
            sourcePiEntryId: "pi-entry-b",
            createdBy: "assistant_tool",
        });
        expect(store.get(scopeA, "missing")).toBeUndefined();
    });

    it("updates pin and replacement state without changing backend identity", () => {
        const database = openDatabase();
        const store = new MemoryPresentationStore(database.orm);
        store.recordDirectCreation(scopeA, {
            backendMemoryId: "old-memory",
            sourcePiEntryId: "pi-entry-1",
            createdBy: "user_capture",
        });

        store.setPinned(scopeA, "old-memory", true);
        store.recordReplacement(scopeA, "old-memory", "new-memory");

        expect(store.get(scopeA, "old-memory")).toMatchObject({
            backendMemoryId: "old-memory",
            pinned: true,
            replacementMemoryId: "new-memory",
        });
        expect(store.get(scopeB, "old-memory")).toBeUndefined();
    });

    it("deletes metadata only for the forgotten scoped backend record and lists requested IDs", () => {
        const database = openDatabase();
        const store = new MemoryPresentationStore(database.orm);
        for (const backendMemoryId of ["memory-1", "memory-2"]) {
            store.recordDirectCreation(scopeA, {
                backendMemoryId,
                sourcePiEntryId: `pi-${backendMemoryId}`,
                createdBy: "imported",
            });
        }
        store.recordDirectCreation(scopeB, {
            backendMemoryId: "memory-1",
            sourcePiEntryId: "pi-other-scope",
            createdBy: "auto_episode",
        });

        expect(store.list(scopeA, ["missing", "memory-2", "memory-1"]).map((row) => row.backendMemoryId)).toEqual([
            "memory-2",
            "memory-1",
        ]);
        store.forget(scopeA, "memory-1");
        expect(store.get(scopeA, "memory-1")).toBeUndefined();
        expect(store.get(scopeB, "memory-1")).toMatchObject({ sourcePiEntryId: "pi-other-scope" });
    });

    it("has no content or body-text column and never persists a memory body", () => {
        const database = openDatabase();
        const store = new MemoryPresentationStore(database.orm);
        store.recordDirectCreation(scopeA, {
            backendMemoryId: "backend-1",
            sourcePiEntryId: "pi-entry-1",
            createdBy: "user_capture",
        });

        const columns = database.connection
            .prepare("PRAGMA table_info(memory_presentation)")
            .all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).not.toEqual(
            expect.arrayContaining(["text", "content", "normalized_text", "memory_text"]),
        );
        const rows = database.connection
            .prepare("SELECT * FROM memory_presentation")
            .all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).not.toHaveProperty("text");
        expect(rows[0]).not.toHaveProperty("content");
    });
});
