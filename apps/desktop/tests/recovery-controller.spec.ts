import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createVerifiedRecoveryExport,
	type NativeRecoveryInterface,
	RECOVERY_ACTIONS,
	type RecoveryAction,
	RecoveryController,
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
	it("offers only current recovery actions", async () => {
		const root = temporaryRoot();
		mkdirSync(join(root, "data"));
		const ui = native({ action: null });
		const recovery = controller({ root, native: ui });
		expect(recovery.prompt()).toEqual({
			reason: "Initialization could not safely continue",
			actions: RECOVERY_ACTIONS,
		});
		expect(await recovery.present()).toEqual({ status: "cancelled", action: "exit" });
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

	it("exports before safe reset and then resolves the incident", async () => {
		const root = temporaryRoot();
		const dataRoot = join(root, "data");
		const destination = join(root, "safe-reset-export");
		mkdirSync(dataRoot);
		writeFileSync(join(dataRoot, "state"), "valuable");
		const store = new RecoveryStateStore(join(root, "recovery-state"));
		const current = incident(store, root);
		const order: string[] = [];
		const result = await controller({
			root,
			dataRoot,
			incident: current,
			store,
			native: native({ destination }),
			files: {
				exportData: (source, target) => {
					order.push("export");
					createVerifiedRecoveryExport(source, target);
				},
				replace: async () => {
					order.push("reset");
					expect(existsSync(join(destination, "state"))).toBe(true);
				},
			},
		}).execute("safe_reset");
		expect(result).toMatchObject({ status: "succeeded", incidentResolved: true });
		expect(order).toEqual(["export", "reset"]);
	});
});
