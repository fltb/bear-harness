// @vitest-environment node

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	completePendingProductResets,
	inspectBootstrapHealth,
	repairCompanionDatabase,
	repairSystemDatabase,
	resetProductData,
	restoreDefaultCharacterPackage,
	selectDefaultCharacter,
} from "../src/storage/bootstrap-recovery.js";
import { CompanionStorageRegistry } from "../src/storage/companion-storage.js";

const roots: string[] = [];
const characterSeedRoot = resolve(import.meta.dirname, "../../../config/characters");

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "bear-bootstrap-recovery-"));
	roots.push(value);
	return value;
}

function options(dataDir: string) {
	return { dataDir, characterSeedRoot, defaultCharacterId: "jizhou" };
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("bootstrap fatal recovery", () => {
	it("classifies and rebuilds a damaged settings database while preserving valid rows", () => {
		const dataDir = root();
		const storage = new CompanionStorageRegistry(dataDir);
		storage.system.connection
			.prepare(
				"INSERT INTO configured_models(provider_id, model_id, label, supports_images) VALUES(?,?,?,?)",
			)
			.run("provider", "model", "Recovered model", 1);
		storage.system.connection
			.prepare("UPDATE app_settings SET network_proxy = ? WHERE id = 1")
			.run("{broken-json");
		storage.close();

		expect(inspectBootstrapHealth(options(dataDir))).toMatchObject({
			status: "fatal",
			issue: { kind: "settings_database" },
		});
		const result = repairSystemDatabase(dataDir);
		expect(result.backupDirectory && existsSync(result.backupDirectory)).toBe(true);
		const database = new DatabaseSync(join(dataDir, "system", "settings.db"), { readOnly: true });
		try {
			expect(database.prepare("SELECT network_proxy FROM app_settings WHERE id=1").get()).toEqual({
				network_proxy: '{"mode":"auto"}',
			});
			expect(
				database.prepare("SELECT label FROM configured_models WHERE provider_id='provider'").get(),
			).toEqual({ label: "Recovered model" });
		} finally {
			database.close();
		}
		expect(inspectBootstrapHealth(options(dataDir)).status).toBe("ok");
	});

	it("activates a verified rebuilt database after a crash moved the old file", () => {
		const dataDir = root();
		const storage = new CompanionStorageRegistry(dataDir);
		storage.close();
		const systemRoot = join(dataDir, "system");
		const target = join(systemRoot, "settings.db");
		const repair = join(systemRoot, ".settings.db.repair-fixed");
		mkdirSync(repair);
		copyFileSync(target, join(repair, "new.db"));
		renameSync(target, join(repair, "original.db"));

		expect(inspectBootstrapHealth(options(dataDir)).status).toBe("ok");
		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(systemRoot, ".settings.db.corrupt-fixed", "original.db"))).toBe(true);
	});

	it("rebuilds only the active companion database and preserves its session catalog", () => {
		const dataDir = root();
		const storage = new CompanionStorageRegistry(dataDir);
		const handle = storage.open("jizhou");
		handle.database.connection
			.prepare("INSERT INTO conversations(id, companion_id) VALUES(?,?)")
			.run("conversation-1", "jizhou");
		handle.database.connection.exec("PRAGMA foreign_keys = OFF");
		handle.database.connection
			.prepare("UPDATE runtime_identity SET companion_id='wrong-character' WHERE id=1")
			.run();
		storage.close();

		expect(inspectBootstrapHealth(options(dataDir))).toMatchObject({
			status: "fatal",
			issue: { kind: "companion_database", characterId: "jizhou" },
		});
		repairCompanionDatabase(dataDir, "jizhou");
		const database = new DatabaseSync(join(dataDir, "companions", "jizhou", "runtime.db"), {
			readOnly: true,
		});
		try {
			expect(
				database.prepare("SELECT companion_id FROM runtime_identity WHERE id=1").get(),
			).toEqual({
				companion_id: "jizhou",
			});
			// A catalog row whose character ownership is still valid survives identity repair.
			expect(database.prepare("SELECT id FROM conversations").all()).toEqual([
				{ id: "conversation-1" },
			]);
		} finally {
			database.close();
		}
	});

	it("does not escalate damage that remains removable by switching characters or deleting a session", () => {
		const dataDir = root();
		expect(inspectBootstrapHealth(options(dataDir)).status).toBe("ok");

		const inactivePackage = join(dataDir, "characters", "broken-character");
		mkdirSync(inactivePackage);
		writeFileSync(join(inactivePackage, "character.yaml"), "not: a-valid-character\n");
		const inactiveRuntime = join(dataDir, "companions", "broken-character");
		mkdirSync(inactiveRuntime, { recursive: true });
		writeFileSync(join(inactiveRuntime, "runtime.db"), "not sqlite");
		const activeSessions = join(dataDir, "companions", "jizhou", "sessions");
		mkdirSync(activeSessions, { recursive: true });
		writeFileSync(join(activeSessions, "broken-session.jsonl"), "{interrupted");

		expect(inspectBootstrapHealth(options(dataDir))).toEqual({
			status: "ok",
			activeCharacterId: "jizhou",
		});
	});

	it("classifies an unusable active non-default package and recovers by selecting the default", () => {
		const dataDir = root();
		expect(inspectBootstrapHealth(options(dataDir)).status).toBe("ok");
		const storage = new CompanionStorageRegistry(dataDir);
		storage.close();
		const database = new DatabaseSync(join(dataDir, "system", "settings.db"));
		try {
			database
				.prepare("INSERT INTO companion_packages(id, name) VALUES('broken-character', 'Broken')")
				.run();
			database
				.prepare(
					"INSERT INTO companion_identity(id, package_id, name) VALUES('broken-character', 'broken-character', 'Broken')",
				)
				.run();
			database
				.prepare(
					"INSERT INTO active_character(singleton, character_id) VALUES(1, 'broken-character')",
				)
				.run();
		} finally {
			database.close();
		}
		const packageRoot = join(dataDir, "characters", "broken-character");
		mkdirSync(packageRoot);
		writeFileSync(join(packageRoot, "character.yaml"), "invalid: true\n");

		expect(inspectBootstrapHealth(options(dataDir))).toMatchObject({
			status: "fatal",
			issue: {
				kind: "character_package",
				characterId: "broken-character",
				defaultCharacter: false,
			},
		});
		selectDefaultCharacter(options(dataDir));
		expect(inspectBootstrapHealth(options(dataDir))).toEqual({
			status: "ok",
			activeCharacterId: "jizhou",
		});
	});

	it("restores a damaged default package from the trusted seed and preserves the old bytes", () => {
		const dataDir = root();
		const initial = inspectBootstrapHealth(options(dataDir));
		expect(initial.status).toBe("ok");
		const packageRoot = join(dataDir, "characters", "jizhou");
		writeFileSync(join(packageRoot, "character.yaml"), "id: jizhou\ninvalid: true\n");
		expect(inspectBootstrapHealth(options(dataDir))).toMatchObject({
			status: "fatal",
			issue: { kind: "character_package", defaultCharacter: true },
		});
		const backup = restoreDefaultCharacterPackage(options(dataDir));
		expect(backup && readFileSync(join(backup, "package", "character.yaml"), "utf8")).toContain(
			"invalid: true",
		);
		expect(inspectBootstrapHealth(options(dataDir)).status).toBe("ok");
	});

	it("finishes an interrupted product reset from directory state alone", () => {
		const dataDir = root();
		const recoveryRoot = join(root(), "recovery");
		for (const name of ["system", "characters", "companions"]) {
			mkdirSync(join(dataDir, name), { recursive: true });
			writeFileSync(join(dataDir, name, "value"), name);
		}
		const transaction = join(recoveryRoot, ".resetting-fixed");
		mkdirSync(transaction, { recursive: true });
		renameSync(join(dataDir, "system"), join(transaction, "system"));

		const [backup] = completePendingProductResets(dataDir, recoveryRoot);
		expect(backup).toBe(join(recoveryRoot, "reset-backup-fixed"));
		if (!backup) throw new Error("expected reset backup");
		for (const name of ["system", "characters", "companions"]) {
			expect(existsSync(join(dataDir, name))).toBe(false);
			expect(readFileSync(join(backup, name, "value"), "utf8")).toBe(name);
		}
		expect(completePendingProductResets(dataDir, recoveryRoot)).toEqual([]);
	});

	it("resets only Bear-owned directories and leaves the Electron profile untouched", () => {
		const dataDir = root();
		const recoveryRoot = join(root(), "recovery");
		mkdirSync(join(dataDir, "Chromium"), { recursive: true });
		writeFileSync(join(dataDir, "Chromium", "profile"), "keep");
		for (const name of ["system", "characters", "companions"])
			mkdirSync(join(dataDir, name), { recursive: true });
		const backup = resetProductData(dataDir, recoveryRoot);
		expect(readFileSync(join(dataDir, "Chromium", "profile"), "utf8")).toBe("keep");
		expect(existsSync(join(backup, "system"))).toBe(true);
	});
});
