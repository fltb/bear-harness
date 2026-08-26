import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const READY_MARKER = "STORAGE_CRASH_READY";

function syncPath(path) {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function syncDirectory(path) {
	try {
		syncPath(path);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	}
}

function writeDurable(path, contents) {
	writeFileSync(path, contents, { encoding: "utf8", flush: true });
}

function writeMarker(markerPath, marker) {
	const temporaryPath = `${markerPath}.tmp-${process.pid}`;
	writeDurable(temporaryPath, `${JSON.stringify(marker)}\n`);
	renameSync(temporaryPath, markerPath);
	syncDirectory(dirname(markerPath));
}

function emitReadyAndCrash() {
	process.stdout.write(`${READY_MARKER}\n`, () => {
		process.kill(process.pid, "SIGKILL");
	});
}

function crashAfterCommittedWal(databasePath) {
	const database = new DatabaseSync(databasePath);
	database.exec("PRAGMA foreign_keys = ON");
	database.exec("PRAGMA journal_mode = WAL");
	database.exec("PRAGMA wal_autocheckpoint = 0");
	database.exec("PRAGMA synchronous = FULL");
	database.exec("BEGIN IMMEDIATE");
	database
		.prepare("INSERT INTO durable_rows (id, value) VALUES (?, ?)")
		.run(2, "committed in crashed WAL writer");
	database.prepare("INSERT INTO durable_children (id, durable_row_id) VALUES (?, ?)").run(2, 2);
	database.exec("COMMIT");
	syncPath(`${databasePath}-wal`);
	emitReadyAndCrash();
}

function crashWithUncommittedMigration(databasePath) {
	const database = new DatabaseSync(databasePath);
	database.exec("PRAGMA foreign_keys = ON");
	database.exec("PRAGMA journal_mode = WAL");
	database.exec("PRAGMA synchronous = FULL");
	database.exec("PRAGMA cache_size = 1");
	database.exec("BEGIN IMMEDIATE");
	database.exec(`
		CREATE TABLE interrupted_upgrade (
			id INTEGER PRIMARY KEY,
			durable_row_id INTEGER NOT NULL REFERENCES durable_rows(id)
		);
		INSERT INTO durable_rows (id, value) VALUES (2, 'uncommitted migration row');
		INSERT INTO durable_children (id, durable_row_id) VALUES (2, 2);
		INSERT INTO interrupted_upgrade (id, durable_row_id) VALUES (1, 2);
		INSERT INTO schema_migrations (id, checksum) VALUES (2, 'uncommitted');
	`);
	if (!existsSync(`${databasePath}-wal`)) {
		throw new Error("uncommitted transaction did not create a WAL file");
	}
	syncPath(`${databasePath}-wal`);
	emitReadyAndCrash();
}

function stageReplacement(stagingPath, targetKind, generation) {
	if (targetKind === "file") {
		writeDurable(
			stagingPath,
			`${JSON.stringify({ generation, payload: generation.repeat(4096) })}\n`,
		);
		return;
	}
	if (targetKind !== "directory") throw new Error(`unknown target kind: ${targetKind}`);
	const payloadPath = join(stagingPath, "payload");
	const nestedPath = join(payloadPath, "nested");
	mkdirSync(nestedPath, { recursive: true });
	writeDurable(join(stagingPath, "manifest.json"), `${JSON.stringify({ generation, files: 2 })}\n`);
	writeDurable(join(payloadPath, "chunk-a.txt"), `${generation}:a:${generation.repeat(2048)}\n`);
	writeDurable(join(nestedPath, "chunk-b.txt"), `${generation}:b:${generation.repeat(2048)}\n`);
	syncDirectory(nestedPath);
	syncDirectory(payloadPath);
	syncDirectory(stagingPath);
}

function crashDuringDurableReplacement(window, root, target, targetKind) {
	const parent = dirname(target);
	const base = basename(target);
	const transactionId = randomUUID();
	const markerPath = join(parent, `.${base}.durable-transaction.json`);
	const marker = {
		version: 1,
		transactionId,
		target,
		staging: join(parent, `.${base}.staging-${transactionId}`),
		backup: join(parent, `.${base}.backup-${transactionId}`),
		state: "staged",
	};

	stageReplacement(marker.staging, targetKind, "new");
	syncDirectory(parent);
	writeMarker(markerPath, marker);
	renameSync(target, marker.backup);
	syncDirectory(parent);
	if (window === "after-target-to-backup") {
		emitReadyAndCrash();
		return;
	}
	if (window !== "after-staging-to-target") throw new Error(`unknown crash window: ${window}`);
	marker.state = "old-target-moved";
	writeMarker(markerPath, marker);
	renameSync(marker.staging, target);
	syncDirectory(parent);
	emitReadyAndCrash();
}

try {
	const [mode, ...args] = process.argv.slice(2);
	if (mode === "wal-committed") {
		crashAfterCommittedWal(args[0]);
	} else if (mode === "uncommitted-migration") {
		crashWithUncommittedMigration(args[0]);
	} else if (mode === "durable-replacement") {
		crashDuringDurableReplacement(args[0], args[1], args[2], args[3]);
	} else {
		throw new Error(`unknown storage crash mode: ${mode ?? "<missing>"}`);
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
}
