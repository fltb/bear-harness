import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createVerifiedRecoveryExport,
	type NativeRecoveryInterface,
	RECOVERY_ACTIONS,
	type RecoveryAction,
	RecoveryController,
} from "../src/main/recovery-controller.js";
import {
	type DatabaseUpgradeRecoveryIncident,
	type RecoveryIncident,
	RecoveryStateStore,
	type RootMigrationRecoveryIncident,
} from "../src/main/recovery-state.js";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "bear-recovery-controller-"));
	temporaryRoots.push(root);
	return root;
}

function createDatabase(
	path: string,
	options: { invalidForeignKey?: boolean; value?: string } = {},
): void {
	mkdirSync(dirname(path), { recursive: true });
	const database = new DatabaseSync(path);
	try {
		database.exec(`
			PRAGMA foreign_keys = OFF;
			CREATE TABLE parent (id INTEGER PRIMARY KEY);
			CREATE TABLE child (
				id INTEGER PRIMARY KEY,
				parent_id INTEGER NOT NULL REFERENCES parent(id),
				value TEXT NOT NULL
			);
		`);
		database.prepare("INSERT INTO parent (id) VALUES (1)").run();
		database
			.prepare("INSERT INTO child (id, parent_id, value) VALUES (?, ?, ?)")
			.run(1, options.invalidForeignKey ? 999 : 1, options.value ?? "value");
	} finally {
		database.close();
	}
}

function databaseValue(path: string): string {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return String(database.prepare("SELECT value FROM child WHERE id = 1").get()?.value);
	} finally {
		database.close();
	}
}

function databaseIncident(
	store: RecoveryStateStore,
	root: string,
	overrides: Partial<{
		databasePath: string;
		backupPath: string;
	}> = {},
): DatabaseUpgradeRecoveryIncident {
	const result = store.upsert({
		id: "database-upgrade",
		kind: "database_upgrade",
		databasePath: overrides.databasePath ?? join(root, "data", "storage", "canon.db"),
		backupPath: overrides.backupPath ?? join(root, "backup", "canon.db"),
		fromVersion: 3,
		toVersion: 4,
		reason: "Schema upgrade was interrupted",
	});
	if (result.status !== "ok" || result.record.kind !== "database_upgrade") {
		throw new Error("fixture incident was not persisted");
	}
	return result.record;
}

function rootIncident(store: RecoveryStateStore, root: string): RootMigrationRecoveryIncident {
	const result = store.upsert({
		id: "root-migration",
		kind: "root_migration",
		sourceRoot: join(root, "legacy"),
		destinationRoot: join(root, "current"),
		reason: "Data roots are ambiguous",
	});
	if (result.status !== "ok" || result.record.kind !== "root_migration") {
		throw new Error("fixture incident was not persisted");
	}
	return result.record;
}

function native(
	options: { action?: RecoveryAction | null; destination?: string | null } = {},
): NativeRecoveryInterface & {
	opened: string[];
	exitCalls: number;
} {
	const result = {
		opened: [] as string[],
		exitCalls: 0,
		chooseAction: vi.fn(async () => options.action ?? null),
		chooseDestination: vi.fn(async () => options.destination ?? null),
		openPath: vi.fn(async (path: string) => {
			result.opened.push(path);
		}),
		exit: vi.fn(() => {
			result.exitCalls += 1;
		}),
	};
	return result;
}

function controller(options: {
	root: string;
	dataRoot?: string;
	incident?: RecoveryIncident;
	store?: RecoveryStateStore;
	native?: NativeRecoveryInterface;
	retry?: () => boolean | Promise<boolean>;
	files?: ConstructorParameters<typeof RecoveryController>[0]["files"];
}): RecoveryController {
	return new RecoveryController({
		reason: "Initialization could not safely continue",
		dataRoot: options.dataRoot ?? join(options.root, "data"),
		...(options.incident ? { incident: options.incident } : {}),
		...(options.store ? { stateStore: options.store } : {}),
		native: options.native ?? native(),
		retry: options.retry ?? (() => false),
		...(options.files ? { files: options.files } : {}),
		now: () => new Date("2026-08-26T10:20:30.000Z"),
	});
}

function expectPending(store: RecoveryStateStore, id: string): void {
	const result = store.get(id);
	expect(result.status).toBe("ok");
	if (result.status === "ok") expect(result.record.status).toBe("pending");
}

function expectResolved(store: RecoveryStateStore, id: string): void {
	const result = store.get(id);
	expect(result.status).toBe("ok");
	if (result.status === "ok") {
		expect(result.record.status).toBe("resolved");
		expect(result.record.resolution).not.toContain(join(tmpdir(), "bear-recovery-controller-"));
	}
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RecoveryController", () => {
	it("presents the initialization reason and every native recovery action", async () => {
		const root = temporaryRoot();
		mkdirSync(join(root, "data"));
		const ui = native({ action: null });
		const recovery = controller({ root, native: ui });

		expect(recovery.prompt()).toEqual({
			reason: "Initialization could not safely continue",
			actions: RECOVERY_ACTIONS,
		});
		expect(await recovery.present()).toEqual({ status: "cancelled", action: "exit" });
		expect(ui.exitCalls).toBe(0);
	});

	it("retries initialization and resolves only after retry reports success", async () => {
		const root = temporaryRoot();
		mkdirSync(join(root, "data"), { recursive: true });
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const incident = databaseIncident(store, root);
		const retry = vi.fn(async () => true);

		const result = await controller({ root, incident, store, retry }).execute("retry");

		expect(result).toMatchObject({
			status: "succeeded",
			action: "retry",
			restartRequired: true,
			incidentResolved: true,
		});
		expect(retry).toHaveBeenCalledOnce();
		expectResolved(store, incident.id);
	});

	it("retains the incident when retry fails", async () => {
		const root = temporaryRoot();
		mkdirSync(join(root, "data"), { recursive: true });
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const incident = databaseIncident(store, root);

		expect(await controller({ root, incident, store }).execute("retry")).toMatchObject({
			status: "failed",
			action: "retry",
		});
		expectPending(store, incident.id);
	});

	it("restores a SQLite-valid backup with durable replacement", async () => {
		const root = temporaryRoot();
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const incident = databaseIncident(store, root);
		createDatabase(incident.databasePath, { value: "damaged-version" });
		createDatabase(incident.backupPath, { value: "verified-backup" });

		const result = await controller({ root, incident, store }).execute("restore_backup");

		expect(result).toMatchObject({ status: "succeeded", restartRequired: true });
		expect(databaseValue(incident.databasePath)).toBe("verified-backup");
		expectResolved(store, incident.id);
	});

	it("refuses a backup with foreign-key violations and retains the incident", async () => {
		const root = temporaryRoot();
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const incident = databaseIncident(store, root);
		createDatabase(incident.databasePath, { value: "untouched" });
		createDatabase(incident.backupPath, { invalidForeignKey: true, value: "invalid" });

		expect(await controller({ root, incident, store }).execute("restore_backup")).toMatchObject({
			status: "failed",
			message: expect.stringContaining("foreign-key"),
		});
		expect(databaseValue(incident.databasePath)).toBe("untouched");
		expectPending(store, incident.id);
	});

	it("restores a byte-verified root backup and its valid database", async () => {
		const root = temporaryRoot();
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const incident = rootIncident(store, root);
		mkdirSync(incident.sourceRoot, { recursive: true });
		mkdirSync(incident.destinationRoot, { recursive: true });
		writeFileSync(join(incident.sourceRoot, "settings.json"), "backup-settings");
		writeFileSync(join(incident.destinationRoot, "settings.json"), "current-settings");
		createDatabase(join(incident.sourceRoot, "storage", "canon.db"));

		expect(
			await controller({
				root,
				dataRoot: incident.destinationRoot,
				incident,
				store,
			}).execute("restore_backup"),
		).toMatchObject({ status: "succeeded" });
		expect(readFileSync(join(incident.destinationRoot, "settings.json"), "utf8")).toBe(
			"backup-settings",
		);
		expectResolved(store, incident.id);
	});

	it("exports the untouched data tree and verifies every copied file", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "chosen-export");
		mkdirSync(join(dataRoot, "nested"), { recursive: true });
		writeFileSync(join(dataRoot, "nested", "state.bin"), Buffer.from([0, 1, 2, 255]));
		const ui = native({ destination });

		expect(await controller({ root, dataRoot, native: ui }).execute("export_data")).toMatchObject({
			status: "succeeded",
			restartRequired: false,
			incidentResolved: false,
		});
		expect(readFileSync(join(destination, "nested", "state.bin"))).toEqual(
			Buffer.from([0, 1, 2, 255]),
		);
	});

	it("never overwrites an existing export destination", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "chosen-export");
		mkdirSync(dataRoot);
		mkdirSync(destination);
		writeFileSync(join(dataRoot, "state"), "source");
		writeFileSync(join(destination, "state"), "existing");

		expect(
			await controller({
				root,
				dataRoot,
				native: native({ destination }),
			}).execute("export_data"),
		).toMatchObject({
			status: "failed",
			message: expect.stringContaining("already exists"),
		});
		expect(readFileSync(join(destination, "state"), "utf8")).toBe("existing");
	});

	it("treats a cancelled destination chooser as a no-op", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot);
		writeFileSync(join(dataRoot, "state"), "untouched");

		expect(
			await controller({
				root,
				dataRoot,
				native: native({ destination: null }),
			}).execute("safe_reset"),
		).toEqual({ status: "cancelled", action: "safe_reset" });
		expect(readFileSync(join(dataRoot, "state"), "utf8")).toBe("untouched");
	});

	it("opens data and backup locations without resolving the incident", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot);
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const incident = databaseIncident(store, root);
		const ui = native();
		const recovery = controller({ root, dataRoot, incident, store, native: ui });

		expect(await recovery.execute("open_data_location")).toMatchObject({ status: "succeeded" });
		expect(await recovery.execute("open_backup_location")).toMatchObject({ status: "succeeded" });
		expect(ui.opened).toEqual([dataRoot, dirname(incident.backupPath)]);
		expectPending(store, incident.id);
	});

	it("creates and verifies the recovery export before safe reset starts", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "safe-reset-export");
		mkdirSync(dataRoot);
		writeFileSync(join(dataRoot, "state"), "valuable");
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const incident = databaseIncident(store, root);
		const order: string[] = [];

		const result = await controller({
			root,
			dataRoot,
			incident,
			store,
			native: native({ destination }),
			files: {
				exportData: (source, target) => {
					order.push("export");
					createVerifiedRecoveryExport(source, target);
					expect(readFileSync(join(target, "state"), "utf8")).toBe("valuable");
				},
				replace: async () => {
					order.push("reset");
					expect(existsSync(join(destination, "state"))).toBe(true);
				},
			},
		}).execute("safe_reset");

		expect(result).toMatchObject({ status: "succeeded", incidentResolved: true });
		expect(order).toEqual(["export", "reset"]);
		expectResolved(store, incident.id);
	});

	it("does not reset or resolve when the required recovery export fails", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot);
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const incident = databaseIncident(store, root);
		const replace = vi.fn(async () => undefined);

		expect(
			await controller({
				root,
				dataRoot,
				incident,
				store,
				native: native({ destination: join(root, "export") }),
				files: {
					exportData: () => {
						throw new Error("copy verification failed");
					},
					replace,
				},
			}).execute("safe_reset"),
		).toMatchObject({ status: "failed" });
		expect(replace).not.toHaveBeenCalled();
		expectPending(store, incident.id);
	});

	it("exits only when the explicit exit action is chosen", async () => {
		const root = temporaryRoot();
		mkdirSync(join(root, "data"));
		const ui = native();

		expect(await controller({ root, native: ui }).execute("exit")).toEqual({
			status: "exit",
			action: "exit",
		});
		expect(ui.exitCalls).toBe(1);
	});
});
