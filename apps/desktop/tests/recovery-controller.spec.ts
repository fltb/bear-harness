import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type NativeRecoveryInterface,
	type RecoveryAction,
	RecoveryController,
	verifySqliteDatabase,
} from "../src/main/recovery-controller.js";
import { type RecoveryIncident, RecoveryStateStore } from "../src/main/recovery-state.js";

const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "bear-recovery-controller-"));
	roots.push(root);
	return root;
}

function incident(store: RecoveryStateStore, root: string): RecoveryIncident {
	const result = store.upsert({
		id: "filesystem-recovery",
		kind: "filesystem_recovery",
		operation: "replace",
		targetPath: join(root, "data", "characters", "jizhou"),
		journalPath: join(root, "data", "audit", "replace.json"),
		reason: "Durable replacement was interrupted",
	});
	if (result.status !== "ok") throw new Error("fixture incident was not persisted");
	return result.record;
}

function native(
	options: { action?: RecoveryAction | null; destination?: string | null } = {},
): NativeRecoveryInterface & { opened: string[]; exitCalls: number } {
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
		now: () => new Date("2026-09-01T00:00:00.000Z"),
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RecoveryController", () => {
	it("keeps dismissal distinct from an explicit exit", async () => {
		const root = temporaryRoot();
		mkdirSync(join(root, "data"));
		const ui = native({ action: null });
		const recovery = controller({ root, native: ui });
		expect(await recovery.present()).toEqual({ status: "cancelled", action: "exit" });
		expect(ui.exitCalls).toBe(0);
		expect(await recovery.execute("exit")).toEqual({ status: "exit", action: "exit" });
		expect(ui.exitCalls).toBe(1);
	});

	it("resolves a filesystem incident after a successful retry", async () => {
		const root = temporaryRoot();
		mkdirSync(join(root, "data"), { recursive: true });
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const current = incident(store, root);
		const result = await controller({
			root,
			incident: current,
			store,
			retry: () => true,
		}).execute("retry");
		expect(result).toMatchObject({ status: "succeeded", incidentResolved: true });
		expect(store.get(current.id)).toMatchObject({
			status: "ok",
			record: { status: "resolved" },
		});
	});

	it("exports the data tree without modifying the source", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "export");
		mkdirSync(join(dataRoot, "nested"), { recursive: true });
		writeFileSync(join(dataRoot, "nested", "state.bin"), Buffer.from([0, 1, 2, 255]));
		mkdirSync(join(dataRoot, "empty"));
		const external = join(root, "external.txt");
		writeFileSync(external, "not owned by the data tree");
		symlinkSync(external, join(dataRoot, "external-link"));
		expect(
			await controller({
				root,
				dataRoot,
				native: native({ destination }),
			}).execute("export_data"),
		).toMatchObject({ status: "succeeded", restartRequired: false });
		expect(readFileSync(join(destination, "nested", "state.bin"))).toEqual(
			Buffer.from([0, 1, 2, 255]),
		);
		expect(readFileSync(join(dataRoot, "nested", "state.bin"))).toEqual(
			Buffer.from([0, 1, 2, 255]),
		);
		expect(readdirSync(join(destination, "empty"))).toEqual([]);
		expect(readlinkSync(join(destination, "external-link"))).toBe(external);
		expect(readFileSync(external, "utf8")).toBe("not owned by the data tree");
	});

	it("rejects a recovery export whose source tree exceeds the supported depth", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "export");
		mkdirSync(dataRoot);
		let nested = dataRoot;
		for (let depth = 0; depth < 130; depth += 1) {
			nested = join(nested, "d");
			mkdirSync(nested);
		}
		writeFileSync(join(nested, "state"), "too deep");

		expect(
			await controller({ root, dataRoot, native: native({ destination }) }).execute("export_data"),
		).toEqual({
			status: "failed",
			action: "export_data",
			message: "Recovery data tree is too deep",
		});
		expect(existsSync(destination)).toBe(false);
	});

	it("opens the current journal location without resolving the incident", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot);
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const current = incident(store, root);
		const ui = native();
		const recovery = controller({ root, dataRoot, incident: current, store, native: ui });
		await recovery.execute("open_data_location");
		await recovery.execute("open_backup_location");
		expect(ui.opened).toEqual([dataRoot, dirname(current.journalPath)]);
		expect(store.get(current.id)).toMatchObject({
			status: "ok",
			record: { status: "pending" },
		});
	});

	it("can resume a cancelled safe reset, preserving a verified export before clearing data", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "safe-reset-export");
		mkdirSync(dataRoot);
		writeFileSync(join(dataRoot, "state"), "valuable");
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const current = incident(store, root);
		const ui = native();
		let selectedDestination: string | null = null;
		ui.chooseDestination = async () => selectedDestination;
		const recovery = controller({ root, dataRoot, incident: current, store, native: ui });

		expect(await recovery.execute("safe_reset")).toEqual({
			status: "cancelled",
			action: "safe_reset",
		});
		expect(readFileSync(join(dataRoot, "state"), "utf8")).toBe("valuable");
		expect(store.get(current.id)).toMatchObject({ status: "ok", record: { status: "pending" } });
		selectedDestination = destination;
		expect(await recovery.execute("safe_reset")).toMatchObject({
			status: "succeeded",
			restartRequired: true,
			incidentResolved: true,
		});
		expect(readFileSync(join(destination, "state"), "utf8")).toBe("valuable");
		expect(readdirSync(dataRoot)).toEqual([]);
		expect(new RecoveryStateStore(store.root).get(current.id)).toMatchObject({
			status: "ok",
			record: { status: "resolved" },
		});
	});

	it("preserves unrelated data when a scoped clear owns the reset", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "export-before-clear");
		mkdirSync(dataRoot);
		writeFileSync(join(dataRoot, "state"), "valuable");
		writeFileSync(join(dataRoot, "settings"), "must survive scoped recovery");
		const recovery = new RecoveryController({
			reason: "filesystem is damaged",
			dataRoot,
			native: native({ destination }),
			retry: () => false,
			clearData: () => {
				rmSync(join(dataRoot, "state"));
			},
		});
		expect(await recovery.execute("safe_reset")).toMatchObject({ status: "succeeded" });
		expect(readFileSync(join(destination, "state"), "utf8")).toBe("valuable");
		expect(existsSync(join(dataRoot, "state"))).toBe(false);
		expect(readFileSync(join(dataRoot, "settings"), "utf8")).toBe("must survive scoped recovery");
	});

	it("keeps the incident pending when initialization returns false or throws", async () => {
		const root = temporaryRoot();
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const current = incident(store, root);
		let attempt = 0;
		const recovery = controller({
			root,
			incident: current,
			store,
			retry: () => {
				if (attempt++ === 0) return false;
				throw new Error("fixture initialization failure");
			},
		});

		expect(await recovery.execute("retry")).toMatchObject({ status: "failed", action: "retry" });
		expect(store.get(current.id)).toMatchObject({ status: "ok", record: { status: "pending" } });
		expect(await recovery.execute("retry")).toEqual({
			status: "failed",
			action: "retry",
			message: "fixture initialization failure",
		});
		expect(store.get(current.id)).toMatchObject({ status: "ok", record: { status: "pending" } });
	});

	it("does not report recovery when the incident disappears during an initialization retry", async () => {
		const root = temporaryRoot();
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const current = incident(store, root);
		let finishRetry!: (success: boolean) => void;
		const retry = new Promise<boolean>((resolve) => {
			finishRetry = resolve;
		});
		const recovery = controller({ root, incident: current, store, retry: () => retry });
		const result = recovery.execute("retry");
		rmSync(join(store.root, `${current.id}.json`));
		finishRetry(true);

		expect(await result).toMatchObject({ status: "failed", action: "retry" });
		expect(store.get(current.id)).toEqual({ status: "not_found", id: current.id });
	});

	it("refuses to reset when the export would be inside the data being cleared", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot);
		writeFileSync(join(dataRoot, "state"), "valuable");
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const current = incident(store, root);
		const destination = join(dataRoot, "export");

		expect(
			await controller({
				root,
				incident: current,
				store,
				native: native({ destination }),
			}).execute("safe_reset"),
		).toMatchObject({ status: "failed", action: "safe_reset" });
		expect(readFileSync(join(dataRoot, "state"), "utf8")).toBe("valuable");
		expect(existsSync(destination)).toBe(false);
		expect(store.get(current.id)).toMatchObject({ status: "ok", record: { status: "pending" } });
	});

	it("rejects exports hidden inside the source by symlinked ancestors before creating any copy", async () => {
		const root = temporaryRoot();
		const physicalParent = join(root, "physical");
		const physicalData = join(physicalParent, "data");
		const nested = join(physicalData, "nested");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(physicalData, "state"), "valuable");
		const sourceAlias = join(root, "source-alias");
		const destinationAlias = join(root, "destination-alias");
		symlinkSync(physicalParent, sourceAlias, "dir");
		symlinkSync(physicalData, destinationAlias, "dir");
		const dataRoot = join(sourceAlias, "data");
		const destination = join(destinationAlias, "nested", "export");
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const current = incident(store, root);

		expect(
			await controller({
				root,
				dataRoot,
				incident: current,
				store,
				native: native({ destination }),
			}).execute("safe_reset"),
		).toMatchObject({ status: "failed", action: "safe_reset" });
		expect(readdirSync(nested)).toEqual([]);
		expect(readFileSync(join(physicalData, "state"), "utf8")).toBe("valuable");
		expect(store.get(current.id)).toMatchObject({ status: "ok", record: { status: "pending" } });
	});

	it("preserves an existing export instead of overwriting it or resetting the source", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "export");
		mkdirSync(dataRoot);
		mkdirSync(destination);
		writeFileSync(join(dataRoot, "state"), "current data");
		writeFileSync(join(destination, "state"), "previous recovery evidence");

		expect(
			await controller({ root, native: native({ destination }) }).execute("safe_reset"),
		).toMatchObject({ status: "failed", action: "safe_reset" });
		expect(readFileSync(join(dataRoot, "state"), "utf8")).toBe("current data");
		expect(readFileSync(join(destination, "state"), "utf8")).toBe("previous recovery evidence");
	});

	it("retains the pending incident and exported evidence when clearing data fails", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "export");
		mkdirSync(dataRoot);
		writeFileSync(join(dataRoot, "state"), "valuable");
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const current = incident(store, root);
		const recovery = new RecoveryController({
			reason: "filesystem needs recovery",
			dataRoot,
			incident: current,
			stateStore: store,
			native: native({ destination }),
			retry: () => false,
			clearData: () => {
				throw new Error("fixture clear failure");
			},
		});

		expect(await recovery.execute("safe_reset")).toEqual({
			status: "failed",
			action: "safe_reset",
			message: "fixture clear failure",
		});
		expect(readFileSync(join(destination, "state"), "utf8")).toBe("valuable");
		expect(readFileSync(join(dataRoot, "state"), "utf8")).toBe("valuable");
		expect(store.get(current.id)).toMatchObject({ status: "ok", record: { status: "pending" } });
	});

	it("rejects SQLite recovery candidates with dangling references or unreadable contents", () => {
		const root = temporaryRoot();
		const path = join(root, "candidate.sqlite");
		const database = new DatabaseSync(path);
		try {
			database.exec(`
				PRAGMA foreign_keys = OFF;
				CREATE TABLE parent (id INTEGER PRIMARY KEY);
				CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
				INSERT INTO parent VALUES (1);
				INSERT INTO child VALUES (1);
			`);
			expect(verifySqliteDatabase(path)).toBe(true);
			database.exec("DELETE FROM parent");
			expect(verifySqliteDatabase(path)).toBe(false);
		} finally {
			database.close();
		}
		writeFileSync(path, "not a SQLite database");
		expect(verifySqliteDatabase(path)).toBe(false);
		expect(verifySqliteDatabase(root)).toBe(false);
	});
});
