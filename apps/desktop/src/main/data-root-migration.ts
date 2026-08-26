import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type RecoveryMutationResult,
	RecoveryStateStore,
	recoveryStateRootForAppData,
} from "./recovery-state.js";

export const LEGACY_DATA_DIRECTORY_NAME = "cyber-bear";
export const CANONICAL_DATA_DIRECTORY_NAME = "bear-harness";
export const DATA_ROOT_MIGRATION_MARKER = ".data-root-migration-complete.json";
export const DATA_ROOT_MIGRATION_STAGING_DIRECTORY = ".bear-harness.migration-staging";
export const DATA_ROOT_MIGRATION_INCIDENT_ID = "data-root-migration";

const MARKER_SCHEMA_VERSION = 1 as const;
const CRITICAL_ROOTS: Record<string, true> = {
	characters: true,
	sessions: true,
	artifacts: true,
	"companion-runtime": true,
	memory: true,
	"external-agent-runs": true,
	audit: true,
};

interface TreeSummary {
	regularFileCount: number;
	regularFileBytes: number;
	criticalSha256: Record<string, string>;
}

interface CompletedMarker extends TreeSummary {
	schemaVersion: typeof MARKER_SCHEMA_VERSION;
	state: "completed";
	sourceRoot: string;
	destinationRoot: string;
}

export type DataRootMigrationAction =
	| "created"
	| "canonical"
	| "migrated"
	| "recovered-staging"
	| "test-override";

export type DataRootMigrationRecoveryReason =
	| "ambiguous_roots"
	| "invalid_completed_marker"
	| "invalid_staging"
	| "orphaned_staging"
	| "path_escape"
	| "symlink_rejected"
	| "unsupported_file_type"
	| "verification_failed"
	| "filesystem_error"
	| "recovery_state_error";

export interface DataRootReadyResult {
	status: "ready";
	root: string;
	legacyRoot: string;
	action: DataRootMigrationAction;
	legacyRetained: boolean;
}

export interface DataRootRecoveryRequiredResult {
	status: "recovery_required";
	reason: DataRootMigrationRecoveryReason;
	message: string;
	canonicalRoot: string;
	legacyRoot: string;
	stagingRoot: string;
	incident: RecoveryMutationResult | null;
}

export type DataRootMigrationResult = DataRootReadyResult | DataRootRecoveryRequiredResult;

export interface ResolveDataRootOptions {
	appDataRoot: string;
	canonicalDirectoryName?: string;
	legacyDirectoryName?: string;
	/** Source-E2E uses an isolated appData override and must never inspect a legacy production root. */
	migrateLegacy?: boolean;
	recoveryStore?: RecoveryStateStore;
}

class MigrationSafetyError extends Error {
	constructor(
		readonly reason: DataRootMigrationRecoveryReason,
		message: string,
	) {
		super(message);
		this.name = "MigrationSafetyError";
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function ensureAbsoluteRoot(path: string, label: string): string {
	if (!isAbsolute(path)) throw new MigrationSafetyError("path_escape", `${label} must be absolute`);
	return resolve(path);
}

function pathIsInside(path: string, root: string): boolean {
	const child = relative(root, path);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function safeChild(root: string, name: string): string {
	const path = resolve(root, name);
	if (!pathIsInside(path, root)) {
		throw new MigrationSafetyError("path_escape", "A migration path escaped its data root");
	}
	return path;
}

function entryKind(path: string): "missing" | "directory" | "symlink" | "other" {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return "symlink";
		if (stat.isDirectory()) return "directory";
		return "other";
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "missing";
		throw error;
	}
}

function assertManagedRoot(path: string, label: string): "missing" | "directory" {
	const kind = entryKind(path);
	if (kind === "symlink") {
		throw new MigrationSafetyError("symlink_rejected", `${label} must not be a symbolic link`);
	}
	if (kind === "other") {
		throw new MigrationSafetyError("unsupported_file_type", `${label} must be a directory`);
	}
	return kind;
}

function normalizedRelative(root: string, path: string): string {
	const local = relative(root, path);
	if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
		throw new MigrationSafetyError("path_escape", "A migration entry escaped its data root");
	}
	return local.split(sep).join("/");
}

function isCritical(relativePath: string): boolean {
	if (relativePath === "storage/canon.db") return true;
	const slash = relativePath.indexOf("/");
	const root = slash === -1 ? relativePath : relativePath.slice(0, slash);
	return CRITICAL_ROOTS[root] === true;
}

function hashFile(path: string): string {
	const digest = createHash("sha256");
	const descriptor = openSync(path, constants.O_RDONLY);
	const chunk = Buffer.allocUnsafe(64 * 1024);
	try {
		let bytesRead = 0;
		do {
			bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
			if (bytesRead > 0) digest.update(chunk.subarray(0, bytesRead));
		} while (bytesRead > 0);
	} finally {
		closeSync(descriptor);
	}
	return digest.digest("hex");
}

function scanTree(root: string): TreeSummary {
	let regularFileCount = 0;
	let regularFileBytes = 0;
	const criticalSha256: Record<string, string> = {};

	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (
				entry.name === DATA_ROOT_MIGRATION_MARKER ||
				entry.name === `${DATA_ROOT_MIGRATION_MARKER}.tmp`
			) {
				continue;
			}
			const path = safeChild(directory, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				throw new MigrationSafetyError(
					"symlink_rejected",
					"Symbolic links are not allowed in migrated data",
				);
			}
			if (stat.isDirectory()) {
				visit(path);
				continue;
			}
			if (!stat.isFile()) {
				throw new MigrationSafetyError(
					"unsupported_file_type",
					"Only regular files and directories may be migrated",
				);
			}
			const local = normalizedRelative(root, path);
			regularFileCount += 1;
			regularFileBytes += stat.size;
			if (isCritical(local)) criticalSha256[local] = hashFile(path);
		}
	}

	visit(root);
	return { regularFileCount, regularFileBytes, criticalSha256 };
}

function copyTree(sourceRoot: string, destinationRoot: string): void {
	const sourceMode = lstatSync(sourceRoot).mode & 0o777;
	mkdirSync(destinationRoot, { mode: 0o700 });

	function copyDirectory(source: string, destination: string): void {
		for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (
				entry.name === DATA_ROOT_MIGRATION_MARKER ||
				entry.name === `${DATA_ROOT_MIGRATION_MARKER}.tmp`
			) {
				throw new MigrationSafetyError(
					"invalid_completed_marker",
					"Legacy data contains a reserved migration marker",
				);
			}
			const sourcePath = safeChild(source, entry.name);
			const destinationPath = safeChild(destination, entry.name);
			const stat = lstatSync(sourcePath);
			if (stat.isSymbolicLink()) {
				throw new MigrationSafetyError(
					"symlink_rejected",
					"Symbolic links are not allowed in migrated data",
				);
			}
			if (stat.isDirectory()) {
				mkdirSync(destinationPath, { mode: 0o700 });
				copyDirectory(sourcePath, destinationPath);
				chmodSync(destinationPath, stat.mode & 0o777);
				continue;
			}
			if (!stat.isFile()) {
				throw new MigrationSafetyError(
					"unsupported_file_type",
					"Only regular files and directories may be migrated",
				);
			}
			copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
			chmodSync(destinationPath, stat.mode & 0o777);
		}
	}

	copyDirectory(sourceRoot, destinationRoot);
	chmodSync(destinationRoot, sourceMode);
}

function sameSummary(left: TreeSummary, right: TreeSummary): boolean {
	if (
		left.regularFileCount !== right.regularFileCount ||
		left.regularFileBytes !== right.regularFileBytes
	) {
		return false;
	}
	const leftHashes = Object.entries(left.criticalSha256).sort(([a], [b]) => a.localeCompare(b));
	const rightHashes = Object.entries(right.criticalSha256).sort(([a], [b]) => a.localeCompare(b));
	return (
		leftHashes.length === rightHashes.length &&
		leftHashes.every(([path, digest], index) => {
			const candidate = rightHashes[index];
			return candidate?.[0] === path && candidate[1] === digest;
		})
	);
}

function isTreeSummary(value: unknown): value is TreeSummary {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("regularFileCount" in value) ||
		!("regularFileBytes" in value) ||
		!("criticalSha256" in value)
	) {
		return false;
	}
	const criticalHashes = value.criticalSha256;
	if (
		!Number.isSafeInteger(value.regularFileCount) ||
		Number(value.regularFileCount) < 0 ||
		!Number.isSafeInteger(value.regularFileBytes) ||
		Number(value.regularFileBytes) < 0 ||
		typeof criticalHashes !== "object" ||
		criticalHashes === null ||
		Array.isArray(criticalHashes)
	) {
		return false;
	}
	return Object.entries(criticalHashes).every(
		([path, digest]) =>
			path.length > 0 &&
			!path.startsWith("/") &&
			!path.split("/").includes("..") &&
			typeof digest === "string" &&
			/^[0-9a-f]{64}$/.test(digest),
	);
}

function readCompletedMarker(
	root: string,
	sourceRoot: string,
	destinationRoot: string,
): CompletedMarker | null {
	const markerPath = safeChild(root, DATA_ROOT_MIGRATION_MARKER);
	if (!existsSync(markerPath)) return null;
	const stat = lstatSync(markerPath);
	if (stat.isSymbolicLink()) {
		throw new MigrationSafetyError(
			"symlink_rejected",
			"Migration marker must not be a symbolic link",
		);
	}
	if (!stat.isFile()) return null;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		return null;
	}
	if (
		!isTreeSummary(value) ||
		!("schemaVersion" in value) ||
		!("state" in value) ||
		!("sourceRoot" in value) ||
		!("destinationRoot" in value) ||
		value.schemaVersion !== MARKER_SCHEMA_VERSION ||
		value.state !== "completed" ||
		value.sourceRoot !== sourceRoot ||
		value.destinationRoot !== destinationRoot
	) {
		return null;
	}
	return {
		...value,
		schemaVersion: MARKER_SCHEMA_VERSION,
		state: "completed",
		sourceRoot,
		destinationRoot,
	};
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
			["EACCES", "EISDIR", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "")
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

function writeCompletedMarker(root: string, marker: CompletedMarker): void {
	const markerPath = safeChild(root, DATA_ROOT_MIGRATION_MARKER);
	const temporaryPath = `${markerPath}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	syncFile(temporaryPath);
	renameSync(temporaryPath, markerPath);
	syncDirectory(root);
}

function migrationIncident(
	store: RecoveryStateStore,
	sourceRoot: string,
	destinationRoot: string,
	reason: string,
): RecoveryMutationResult {
	return store.upsert({
		id: DATA_ROOT_MIGRATION_INCIDENT_ID,
		kind: "root_migration",
		sourceRoot,
		destinationRoot,
		reason,
	});
}

function recoverRequired(
	store: RecoveryStateStore,
	canonicalRoot: string,
	legacyRoot: string,
	stagingRoot: string,
	reason: DataRootMigrationRecoveryReason,
	message: string,
): DataRootRecoveryRequiredResult {
	let incident: RecoveryMutationResult | null = null;
	try {
		incident = migrationIncident(store, legacyRoot, canonicalRoot, message);
	} catch {
		return {
			status: "recovery_required",
			reason: "recovery_state_error",
			message: `${message}; recovery state could not be persisted`,
			canonicalRoot,
			legacyRoot,
			stagingRoot,
			incident: null,
		};
	}
	if (incident.status !== "ok") {
		return {
			status: "recovery_required",
			reason: "recovery_state_error",
			message: `${message}; recovery state requires repair`,
			canonicalRoot,
			legacyRoot,
			stagingRoot,
			incident,
		};
	}
	return {
		status: "recovery_required",
		reason,
		message,
		canonicalRoot,
		legacyRoot,
		stagingRoot,
		incident,
	};
}

function ready(
	root: string,
	legacyRoot: string,
	action: DataRootMigrationAction,
): DataRootReadyResult {
	return { status: "ready", root, legacyRoot, action, legacyRetained: existsSync(legacyRoot) };
}

function resolveIncident(store: RecoveryStateStore, resolution: string): void {
	const existing = store.get(DATA_ROOT_MIGRATION_INCIDENT_ID);
	if (existing.status === "ok" && existing.record.status === "pending") {
		const result = store.resolve(DATA_ROOT_MIGRATION_INCIDENT_ID, resolution);
		if (result.status !== "ok") throw new Error("Unable to resolve data-root migration incident");
	}
}

function activateStaging(stagingRoot: string, canonicalRoot: string, appDataRoot: string): void {
	renameSync(stagingRoot, canonicalRoot);
	syncDirectory(appDataRoot);
}

export function resolveDataRoot(options: ResolveDataRootOptions): DataRootMigrationResult {
	let appDataRoot: string;
	try {
		appDataRoot = ensureAbsoluteRoot(options.appDataRoot, "appData root");
		mkdirSync(appDataRoot, { recursive: true, mode: 0o700 });
		if (entryKind(appDataRoot) !== "directory") {
			throw new MigrationSafetyError("symlink_rejected", "appData root must be a real directory");
		}
	} catch (error) {
		throw error instanceof MigrationSafetyError
			? error
			: new MigrationSafetyError("filesystem_error", "Unable to prepare appData root");
	}

	const canonicalRoot = safeChild(
		appDataRoot,
		options.canonicalDirectoryName ?? CANONICAL_DATA_DIRECTORY_NAME,
	);
	const legacyRoot = safeChild(
		appDataRoot,
		options.legacyDirectoryName ?? LEGACY_DATA_DIRECTORY_NAME,
	);
	const stagingRoot = safeChild(appDataRoot, DATA_ROOT_MIGRATION_STAGING_DIRECTORY);
	const recoveryStore =
		options.recoveryStore ??
		new RecoveryStateStore(recoveryStateRootForAppData(appDataRoot), {
			productDataRoots: [legacyRoot, canonicalRoot],
		});

	try {
		const canonicalKind = assertManagedRoot(canonicalRoot, "Canonical data root");
		if (options.migrateLegacy === false) {
			if (canonicalKind === "missing") mkdirSync(canonicalRoot, { recursive: true, mode: 0o700 });
			return ready(canonicalRoot, legacyRoot, "test-override");
		}

		const legacyKind = assertManagedRoot(legacyRoot, "Legacy data root");
		const stagingKind = assertManagedRoot(stagingRoot, "Migration staging root");

		if (canonicalKind === "directory" && legacyKind === "missing") {
			return ready(canonicalRoot, legacyRoot, "canonical");
		}

		if (canonicalKind === "directory" && legacyKind === "directory") {
			const marker = readCompletedMarker(canonicalRoot, legacyRoot, canonicalRoot);
			if (marker && sameSummary(scanTree(canonicalRoot), marker)) {
				resolveIncident(
					recoveryStore,
					"Verified canonical root is active; legacy root retained as backup",
				);
				return ready(canonicalRoot, legacyRoot, "canonical");
			}
			return recoverRequired(
				recoveryStore,
				canonicalRoot,
				legacyRoot,
				stagingRoot,
				marker ? "verification_failed" : "ambiguous_roots",
				marker
					? "Canonical migration marker does not match canonical data"
					: "Both legacy and canonical data roots exist without a valid completed migration marker",
			);
		}

		if (canonicalKind === "missing" && legacyKind === "missing") {
			if (stagingKind === "directory") {
				return recoverRequired(
					recoveryStore,
					canonicalRoot,
					legacyRoot,
					stagingRoot,
					"orphaned_staging",
					"Migration staging exists but its legacy source is missing",
				);
			}
			mkdirSync(canonicalRoot, { recursive: true, mode: 0o700 });
			return ready(canonicalRoot, legacyRoot, "created");
		}

		if (canonicalKind === "missing" && legacyKind === "directory") {
			const pending = migrationIncident(
				recoveryStore,
				legacyRoot,
				canonicalRoot,
				"Legacy data root migration is pending",
			);
			if (pending.status !== "ok") {
				return {
					status: "recovery_required",
					reason: "recovery_state_error",
					message: "Recovery state requires repair before data-root migration can start",
					canonicalRoot,
					legacyRoot,
					stagingRoot,
					incident: pending,
				};
			}

			if (stagingKind === "directory") {
				const stagedMarker = readCompletedMarker(stagingRoot, legacyRoot, canonicalRoot);
				if (stagedMarker) {
					const stagedSummary = scanTree(stagingRoot);
					const currentSourceSummary = scanTree(legacyRoot);
					if (
						sameSummary(stagedSummary, stagedMarker) &&
						sameSummary(currentSourceSummary, stagedMarker)
					) {
						activateStaging(stagingRoot, canonicalRoot, appDataRoot);
						resolveIncident(
							recoveryStore,
							"Verified interrupted staging was activated; legacy root retained as backup",
						);
						return ready(canonicalRoot, legacyRoot, "recovered-staging");
					}
					return recoverRequired(
						recoveryStore,
						canonicalRoot,
						legacyRoot,
						stagingRoot,
						"verification_failed",
						"Completed migration staging no longer matches its source or manifest",
					);
				}
				// A marker-less staging tree was never eligible for activation. Validate it before removal
				// so a malicious link can never turn cleanup into an escape.
				scanTree(stagingRoot);
				rmSync(stagingRoot, { recursive: true, force: false });
				syncDirectory(appDataRoot);
			}

			const sourceBefore = scanTree(legacyRoot);
			copyTree(legacyRoot, stagingRoot);
			const sourceAfter = scanTree(legacyRoot);
			const staged = scanTree(stagingRoot);
			if (!sameSummary(sourceBefore, sourceAfter) || !sameSummary(sourceAfter, staged)) {
				return recoverRequired(
					recoveryStore,
					canonicalRoot,
					legacyRoot,
					stagingRoot,
					"verification_failed",
					"Legacy data changed during migration or staged verification failed",
				);
			}
			writeCompletedMarker(stagingRoot, {
				schemaVersion: MARKER_SCHEMA_VERSION,
				state: "completed",
				sourceRoot: legacyRoot,
				destinationRoot: canonicalRoot,
				...staged,
			});
			activateStaging(stagingRoot, canonicalRoot, appDataRoot);
			resolveIncident(
				recoveryStore,
				"Verified migration activated; legacy root retained as backup",
			);
			return ready(canonicalRoot, legacyRoot, "migrated");
		}

		return recoverRequired(
			recoveryStore,
			canonicalRoot,
			legacyRoot,
			stagingRoot,
			"invalid_staging",
			"Data root migration reached an unsupported filesystem layout",
		);
	} catch (error) {
		const reason = error instanceof MigrationSafetyError ? error.reason : "filesystem_error";
		const message =
			error instanceof MigrationSafetyError
				? error.message
				: "Filesystem error prevented safe data-root migration";
		return recoverRequired(recoveryStore, canonicalRoot, legacyRoot, stagingRoot, reason, message);
	}
}
