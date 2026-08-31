import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	readlinkSync,
	readSync,
	symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { replaceDurableFile } from "@bear-harness/host-runtime";
import type {
	RecoveryIncident,
	RecoveryStateStore,
	RecoveryVerifiedResolution,
} from "./recovery-state.js";

export type RecoveryAction =
	| "retry"
	| "export_data"
	| "open_data_location"
	| "open_backup_location"
	| "safe_reset"
	| "exit";

export const RECOVERY_ACTIONS: readonly RecoveryAction[] = [
	"retry",
	"export_data",
	"open_data_location",
	"open_backup_location",
	"safe_reset",
	"exit",
];

export interface RecoveryPrompt {
	reason: string;
	actions: readonly RecoveryAction[];
}

export interface RecoveryDestinationRequest {
	purpose: "export" | "safe_reset";
	suggestedName: string;
}

/** Native-only boundary. It is deliberately independent of renderer IPC. */
export interface NativeRecoveryInterface {
	chooseAction(prompt: RecoveryPrompt): Promise<RecoveryAction | null>;
	chooseDestination(request: RecoveryDestinationRequest): Promise<string | null>;
	openPath(path: string): Promise<void>;
	exit(): void;
}

export type RecoveryActionResult =
	| { status: "cancelled"; action: RecoveryAction }
	| { status: "exit"; action: "exit" }
	| {
			status: "succeeded";
			action: RecoveryAction;
			restartRequired: boolean;
			incidentResolved: boolean;
	  }
	| { status: "failed"; action: RecoveryAction; message: string };

export interface RecoveryFileOperations {
	replace(options: {
		root: string;
		target: string;
		stage(stagingPath: string): void | Promise<void>;
		verify(candidatePath: string): boolean | Promise<boolean>;
	}): Promise<void>;
	exportData(source: string, destination: string): void;
	verifySqlite(path: string): boolean;
}

export interface RecoveryControllerOptions {
	reason: string;
	dataRoot: string;
	resetTarget?: string;
	incident?: RecoveryIncident;
	stateStore?: Pick<RecoveryStateStore, "resolveVerified">;
	native: NativeRecoveryInterface;
	retry(): boolean | Promise<boolean>;
	files?: Partial<RecoveryFileOperations>;
	now?: () => Date;
}

type ManifestEntry =
	| { kind: "directory" }
	| { kind: "file"; size: number; sha256: string }
	| { kind: "symlink"; target: string };

type TreeManifest = Map<string, ManifestEntry>;

const READ_BUFFER_BYTES = 1024 * 1024;
function errorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim().length > 0
		? error.message
		: "Recovery action failed";
}

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function assertAbsolute(path: string, label: string): string {
	const absolute = resolve(path);
	if (absolute !== path) throw new Error(`${label} must be an absolute normalized path`);
	return absolute;
}

function isWithin(parent: string, candidate: string): boolean {
	const relation = relative(parent, candidate);
	return (
		relation === "" ||
		(!isAbsolute(relation) &&
			!relation.startsWith(`..${sep}`) &&
			relation !== ".." &&
			!relation.startsWith(sep))
	);
}

function assertExportPaths(
	sourceInput: string,
	destinationInput: string,
): {
	source: string;
	destination: string;
} {
	const source = assertAbsolute(sourceInput, "Recovery source");
	const destination = assertAbsolute(destinationInput, "Recovery destination");
	if (!lstatSync(source).isDirectory()) {
		throw new Error("Recovery source must be a real directory");
	}
	if (pathExists(destination)) throw new Error("Recovery export destination already exists");
	if (isWithin(source, destination)) {
		throw new Error("Recovery export destination must be outside the current data root");
	}
	const parent = dirname(destination);
	if (!lstatSync(parent).isDirectory()) {
		throw new Error("Recovery export parent must be a real directory");
	}
	return { source, destination };
}

function syncFile(path: string): void {
	const descriptor = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function syncDirectory(path: string): void {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
	} catch (error) {
		if (
			process.platform === "win32" &&
			["EACCES", "EISDIR", "EPERM"].includes(errorCode(error) ?? "")
		)
			return;
		throw error;
	}
	try {
		fsyncSync(descriptor);
	} catch (error) {
		if (
			process.platform !== "win32" ||
			!["EBADF", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "")
		)
			throw error;
	} finally {
		closeSync(descriptor);
	}
}

function hashFile(path: string): { size: number; sha256: string } {
	const descriptor = openSync(path, constants.O_RDONLY);
	const digest = createHash("sha256");
	const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
	let size = 0;
	try {
		for (;;) {
			const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) break;
			digest.update(buffer.subarray(0, bytesRead));
			size += bytesRead;
		}
	} finally {
		closeSync(descriptor);
	}
	return { size, sha256: digest.digest("hex") };
}

function scanTree(root: string): TreeManifest {
	const manifest: TreeManifest = new Map();
	const visit = (directory: string, relativeDirectory: string): void => {
		const handle = opendirSync(directory);
		const entries: string[] = [];
		try {
			for (;;) {
				const entry = handle.readSync();
				if (!entry) break;
				entries.push(entry.name);
			}
		} finally {
			handle.closeSync();
		}
		entries.sort();
		for (const name of entries) {
			const absolute = join(directory, name);
			const relativePath = relativeDirectory ? join(relativeDirectory, name) : name;
			const stat = lstatSync(absolute);
			if (stat.isDirectory()) {
				manifest.set(relativePath, { kind: "directory" });
				visit(absolute, relativePath);
			} else if (stat.isFile()) {
				manifest.set(relativePath, { kind: "file", ...hashFile(absolute) });
			} else if (stat.isSymbolicLink()) {
				manifest.set(relativePath, { kind: "symlink", target: readlinkSync(absolute) });
			} else {
				throw new Error("Recovery data contains an unsupported filesystem entry");
			}
		}
	};
	visit(root, "");
	return manifest;
}

function manifestsEqual(left: TreeManifest, right: TreeManifest): boolean {
	if (left.size !== right.size) return false;
	for (const [path, expected] of left) {
		const actual = right.get(path);
		if (!actual || expected.kind !== actual.kind) return false;
		if (expected.kind === "file") {
			if (
				actual.kind !== "file" ||
				expected.size !== actual.size ||
				expected.sha256 !== actual.sha256
			)
				return false;
		} else if (expected.kind === "symlink") {
			if (actual.kind !== "symlink" || expected.target !== actual.target) return false;
		}
	}
	return true;
}

function copyTree(source: string, destination: string): void {
	const sourceStat = lstatSync(source);
	mkdirSync(destination, { mode: sourceStat.mode & 0o777 });
	const handle = opendirSync(source);
	try {
		for (;;) {
			const entry = handle.readSync();
			if (!entry) break;
			const sourcePath = join(source, entry.name);
			const destinationPath = join(destination, entry.name);
			const stat = lstatSync(sourcePath);
			if (stat.isDirectory()) {
				copyTree(sourcePath, destinationPath);
			} else if (stat.isFile()) {
				copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
				chmodSync(destinationPath, stat.mode & 0o777);
				syncFile(destinationPath);
			} else if (stat.isSymbolicLink()) {
				symlinkSync(readlinkSync(sourcePath), destinationPath);
			} else {
				throw new Error("Recovery data contains an unsupported filesystem entry");
			}
		}
	} finally {
		handle.closeSync();
	}
	syncDirectory(destination);
}

export function verifySqliteDatabase(path: string): boolean {
	let database: DatabaseSync | undefined;
	try {
		if (!lstatSync(path).isFile()) return false;
		database = new DatabaseSync(path, { readOnly: true });
		const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<
			Record<string, unknown>
		>;
		if (
			integrityRows.length !== 1 ||
			!Object.values(integrityRows[0] ?? {}).some((value) => value === "ok")
		) {
			return false;
		}
		const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
		return foreignKeyRows.length === 0;
	} catch {
		return false;
	} finally {
		database?.close();
	}
}

/** Copy without touching the source, then compare every copied byte/link entry. */
export function createVerifiedRecoveryExport(source: string, destination: string): void {
	const paths = assertExportPaths(source, destination);
	const sourceManifest = scanTree(paths.source);
	copyTree(paths.source, paths.destination);
	const destinationManifest = scanTree(paths.destination);
	if (!manifestsEqual(sourceManifest, destinationManifest)) {
		throw new Error("Recovery export failed byte verification");
	}
	syncDirectory(dirname(paths.destination));
}

function suggestedExportName(dataRoot: string, now: Date): string {
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	return `${basename(dataRoot)}-recovery-${timestamp}`;
}

function backupPathFor(incident: RecoveryIncident | undefined): string | null {
	if (!incident) return null;
	return incident.journalPath;
}

function successfulResolution(action: RecoveryAction): RecoveryVerifiedResolution | null {
	switch (action) {
		case "retry":
			return "retry";
		case "safe_reset":
			return "safe_reset";
		default:
			return null;
	}
}

export class RecoveryController {
	private readonly files: RecoveryFileOperations;
	private readonly now: () => Date;

	constructor(private readonly options: RecoveryControllerOptions) {
		assertAbsolute(options.dataRoot, "Data root");
		if (options.resetTarget) assertAbsolute(options.resetTarget, "Reset target");
		if ((options.incident === undefined) !== (options.stateStore === undefined)) {
			throw new Error("Recovery incident and state store must be provided together");
		}
		this.files = {
			replace: options.files?.replace ?? replaceDurableFile,
			exportData: options.files?.exportData ?? createVerifiedRecoveryExport,
			verifySqlite: options.files?.verifySqlite ?? verifySqliteDatabase,
		};
		this.now = options.now ?? (() => new Date());
	}

	prompt(): RecoveryPrompt {
		return { reason: this.options.reason, actions: RECOVERY_ACTIONS };
	}

	async present(): Promise<RecoveryActionResult> {
		const action = await this.options.native.chooseAction(this.prompt());
		return action === null ? { status: "cancelled", action: "exit" } : this.execute(action);
	}

	async execute(action: RecoveryAction): Promise<RecoveryActionResult> {
		try {
			switch (action) {
				case "retry": {
					if (!(await this.options.retry()))
						throw new Error("Initialization retry did not succeed");
					this.resolveIncident(action);
					return this.success(action, true);
				}
				case "export_data": {
					const destination = await this.chooseDestination("export");
					if (!destination) return { status: "cancelled", action };
					this.files.exportData(this.options.dataRoot, destination);
					return this.success(action, false);
				}
				case "open_data_location":
					await this.options.native.openPath(this.options.dataRoot);
					return this.success(action, false);
				case "open_backup_location": {
					const backup = backupPathFor(this.options.incident);
					if (!backup) throw new Error("No recovery backup location is available");
					await this.options.native.openPath(dirname(backup));
					return this.success(action, false);
				}
				case "safe_reset": {
					const destination = await this.chooseDestination("safe_reset");
					if (!destination) return { status: "cancelled", action };
					this.files.exportData(this.options.dataRoot, destination);
					await this.files.replace({
						root: dirname(this.options.resetTarget ?? this.options.dataRoot),
						target: this.options.resetTarget ?? this.options.dataRoot,
						stage: (stagingPath) => mkdirSync(stagingPath, { mode: 0o700 }),
						verify: (candidatePath) => scanTree(candidatePath).size === 0,
					});
					this.resolveIncident(action);
					return this.success(action, true);
				}
				case "exit":
					this.options.native.exit();
					return { status: "exit", action };
			}
		} catch (error) {
			return { status: "failed", action, message: errorMessage(error) };
		}
	}

	private async chooseDestination(
		purpose: RecoveryDestinationRequest["purpose"],
	): Promise<string | null> {
		const now = this.now();
		if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
			throw new Error("Recovery clock returned an invalid date");
		}
		return this.options.native.chooseDestination({
			purpose,
			suggestedName: suggestedExportName(this.options.dataRoot, now),
		});
	}

	private resolveIncident(action: RecoveryAction): void {
		const resolution = successfulResolution(action);
		const incident = this.options.incident;
		const store = this.options.stateStore;
		if (!resolution || !incident || !store) return;
		const result = store.resolveVerified(incident.id, resolution);
		if (result.status !== "ok" || result.record.status !== "resolved") {
			throw new Error("Verified recovery action could not resolve its incident");
		}
	}

	private success(action: RecoveryAction, restartRequired: boolean): RecoveryActionResult {
		const resolution = successfulResolution(action);
		return {
			status: "succeeded",
			action,
			restartRequired,
			incidentResolved: Boolean(resolution && this.options.incident),
		};
	}
}
