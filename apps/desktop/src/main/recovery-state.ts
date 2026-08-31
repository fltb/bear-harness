import {
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const RECOVERY_STATE_DIRECTORY_NAME = ".bear-harness-recovery-state";

/**
 * Keeps bootstrap incidents beside, never inside, either product data root.
 * This location is available before Electron's userData path is configured.
 */
export function recoveryStateRootForAppData(appDataRoot: string): string {
	if (!isAbsolute(appDataRoot)) {
		throw new RecoveryStateValidationError("appData root must be an absolute path");
	}
	return resolve(appDataRoot, RECOVERY_STATE_DIRECTORY_NAME);
}

export type RecoveryIncidentKind = "filesystem_recovery";
export type RecoveryIncidentStatus = "pending" | "resolved";
export type RecoveryVerifiedResolution = "retry" | "safe_reset";

const VERIFIED_RESOLUTION_MESSAGES: Record<RecoveryVerifiedResolution, string> = {
	retry: "Initialization retry completed successfully",
	safe_reset: "Verified recovery export created before safe reset",
};

interface RecoveryIncidentBase {
	id: string;
	kind: RecoveryIncidentKind;
	status: RecoveryIncidentStatus;
	createdAt: string;
	updatedAt: string;
	resolvedAt: string | null;
	resolution: string | null;
	reason: string;
}

export interface FilesystemRecoveryIncident extends RecoveryIncidentBase {
	kind: "filesystem_recovery";
	operation: "replace" | "move" | "delete";
	targetPath: string;
	journalPath: string;
}

export type RecoveryIncident = FilesystemRecoveryIncident;
export type FilesystemRecoveryIncidentInput = Pick<
	FilesystemRecoveryIncident,
	"id" | "kind" | "operation" | "targetPath" | "journalPath" | "reason"
>;
export type RecoveryIncidentInput = FilesystemRecoveryIncidentInput;

export interface RecoveryRequiredResult {
	status: "recovery_required";
	reason: "malformed_record";
	id: string | null;
	path: string;
	message: string;
}

export type RecoveryGetResult =
	| { status: "ok"; record: RecoveryIncident }
	| { status: "not_found"; id: string }
	| RecoveryRequiredResult;

export type RecoveryListResult =
	| { status: "ok"; records: RecoveryIncident[] }
	| {
			status: "recovery_required";
			records: RecoveryIncident[];
			issues: RecoveryRequiredResult[];
	  };

export type RecoveryMutationResult =
	| { status: "ok"; record: RecoveryIncident; changed: boolean }
	| RecoveryRequiredResult;

export interface RecoveryStateStoreOptions {
	/** Product roots which must not contain this bootstrap store. */
	productDataRoots?: readonly string[];
	/** Injectable wall clock. */
	now?: () => Date;
}

export class RecoveryStateValidationError extends Error {
	override readonly name = "RecoveryStateValidationError";
}

const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const BASE_KEYS = [
	"id",
	"kind",
	"status",
	"createdAt",
	"updatedAt",
	"resolvedAt",
	"resolution",
	"reason",
] as const;
const KIND_KEYS: Record<RecoveryIncidentKind, readonly string[]> = {
	filesystem_recovery: ["operation", "targetPath", "journalPath"],
};
const INPUT_KEYS: Record<RecoveryIncidentKind, readonly string[]> = {
	filesystem_recovery: ["id", "kind", "operation", "targetPath", "journalPath", "reason"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isIncidentKind(value: unknown): value is RecoveryIncidentKind {
	return value === "filesystem_recovery";
}

function isAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

function isNonEmptyText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
}

function isTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateVariantFields(
	value: Record<string, unknown>,
	kind: RecoveryIncidentKind,
): boolean {
	switch (kind) {
		case "filesystem_recovery":
			return (
				(value.operation === "replace" ||
					value.operation === "move" ||
					value.operation === "delete") &&
				isAbsolutePath(value.targetPath) &&
				isAbsolutePath(value.journalPath)
			);
	}
}

function validateStoredRecord(value: unknown): RecoveryIncident | null {
	if (!isPlainObject(value) || !isIncidentKind(value.kind)) return null;
	if (!hasExactKeys(value, [...BASE_KEYS, ...KIND_KEYS[value.kind]])) return null;
	if (
		typeof value.id !== "string" ||
		!ID_PATTERN.test(value.id) ||
		(value.status !== "pending" && value.status !== "resolved") ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.updatedAt) ||
		!isNonEmptyText(value.reason)
	) {
		return null;
	}
	if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return null;
	if (value.status === "pending") {
		if (value.resolvedAt !== null || value.resolution !== null) return null;
	} else {
		if (!isTimestamp(value.resolvedAt) || !isNonEmptyText(value.resolution)) return null;
		if (Date.parse(value.resolvedAt) < Date.parse(value.createdAt)) return null;
		if (value.updatedAt !== value.resolvedAt) return null;
	}
	const common: Omit<RecoveryIncidentBase, "kind"> = {
		id: value.id,
		status: value.status,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		resolvedAt: value.resolvedAt,
		resolution: value.resolution,
		reason: value.reason,
	};
	switch (value.kind) {
		case "filesystem_recovery":
			if (
				(value.operation !== "replace" &&
					value.operation !== "move" &&
					value.operation !== "delete") ||
				!isAbsolutePath(value.targetPath) ||
				!isAbsolutePath(value.journalPath)
			) {
				return null;
			}
			return {
				...common,
				kind: "filesystem_recovery",
				operation: value.operation,
				targetPath: value.targetPath,
				journalPath: value.journalPath,
			};
	}
}

function assertIncidentInput(input: RecoveryIncidentInput): void {
	if (!isPlainObject(input) || !isIncidentKind(input.kind)) {
		throw new RecoveryStateValidationError("Recovery incident kind is invalid");
	}
	if (!hasExactKeys(input, INPUT_KEYS[input.kind])) {
		throw new RecoveryStateValidationError("Recovery incident has an unexpected shape");
	}
	if (typeof input.id !== "string" || !ID_PATTERN.test(input.id)) {
		throw new RecoveryStateValidationError("Recovery incident id is invalid");
	}
	if (!isNonEmptyText(input.reason)) {
		throw new RecoveryStateValidationError("Recovery incident reason is invalid");
	}
	if (!validateVariantFields(input, input.kind)) {
		throw new RecoveryStateValidationError("Recovery incident fields are invalid");
	}
}

function assertIncidentId(id: string): void {
	if (!ID_PATTERN.test(id)) {
		throw new RecoveryStateValidationError("Recovery incident id is invalid");
	}
}

function pathIsInside(path: string, parent: string): boolean {
	const relation = relative(parent, path);
	return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function fsyncDirectory(path: string): void {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
	} catch (error) {
		if (
			process.platform === "win32" &&
			["EACCES", "EISDIR", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "")
		) {
			return;
		}
		throw error;
	}
	try {
		fsyncSync(descriptor);
	} catch (error) {
		if (
			process.platform !== "win32" ||
			!["EBADF", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "")
		) {
			throw error;
		}
	} finally {
		closeSync(descriptor);
	}
}

/**
 * Synchronous bootstrap store. It deliberately has no Electron imports so it
 * can be constructed and inspected before app.setPath() or Host startup.
 */
export class RecoveryStateStore {
	readonly root: string;
	private readonly productDataRoots: readonly string[];
	private readonly now: () => Date;

	constructor(root: string, options: RecoveryStateStoreOptions = {}) {
		if (!isAbsolutePath(root)) {
			throw new RecoveryStateValidationError("Recovery state root must be an absolute path");
		}
		this.root = resolve(root);
		this.productDataRoots = (options.productDataRoots ?? []).map((candidate) => {
			if (!isAbsolutePath(candidate)) {
				throw new RecoveryStateValidationError("Product data roots must be absolute paths");
			}
			return resolve(candidate);
		});
		for (const productRoot of this.productDataRoots) {
			if (pathIsInside(this.root, productRoot)) {
				throw new RecoveryStateValidationError(
					"Recovery state root must be outside product data roots",
				);
			}
		}
		this.now = options.now ?? (() => new Date());
	}

	list(): RecoveryListResult {
		this.prepareRoot();
		const issues = this.cleanTemporaryFiles();
		const records: RecoveryIncident[] = [];
		for (const entry of readdirSync(this.root, { withFileTypes: true })) {
			if (!entry.name.endsWith(".json")) continue;
			const id = entry.name.slice(0, -".json".length);
			if (!entry.isFile() || !ID_PATTERN.test(id)) {
				issues.push(this.malformed(id || null, resolve(this.root, entry.name)));
				continue;
			}
			const result = this.readRecord(id);
			if (result.status === "ok") records.push(result.record);
			else if (result.status === "recovery_required") issues.push(result);
		}
		records.sort((left, right) =>
			left.createdAt === right.createdAt
				? left.id.localeCompare(right.id)
				: left.createdAt.localeCompare(right.createdAt),
		);
		return issues.length === 0
			? { status: "ok", records }
			: { status: "recovery_required", records, issues };
	}

	get(id: string): RecoveryGetResult {
		assertIncidentId(id);
		this.prepareRoot();
		const temporaryIssue = this.cleanTemporaryFile(id);
		if (temporaryIssue) return temporaryIssue;
		return this.readRecord(id);
	}

	upsert(input: RecoveryIncidentInput): RecoveryMutationResult {
		assertIncidentInput(input);
		this.prepareRoot();
		const temporaryIssue = this.cleanTemporaryFile(input.id);
		if (temporaryIssue) return temporaryIssue;
		const existing = this.readRecord(input.id);
		if (existing.status === "recovery_required") return existing;
		if (existing.status === "ok" && existing.record.status === "resolved") {
			return { status: "ok", record: existing.record, changed: false };
		}
		if (existing.status === "ok" && existing.record.kind !== input.kind) {
			throw new RecoveryStateValidationError("Recovery incident kind cannot change");
		}
		const timestamp = this.timestamp();
		const record: RecoveryIncident = {
			...input,
			status: "pending",
			createdAt: existing.status === "ok" ? existing.record.createdAt : timestamp,
			updatedAt:
				existing.status === "ok" && existing.record.updatedAt > timestamp
					? existing.record.updatedAt
					: timestamp,
			resolvedAt: null,
			resolution: null,
		};
		this.writeRecord(record);
		return { status: "ok", record, changed: true };
	}

	resolve(
		id: string,
		resolution: string,
	): RecoveryMutationResult | { status: "not_found"; id: string } {
		assertIncidentId(id);
		if (!isNonEmptyText(resolution)) {
			throw new RecoveryStateValidationError("Recovery resolution is invalid");
		}
		this.prepareRoot();
		const temporaryIssue = this.cleanTemporaryFile(id);
		if (temporaryIssue) return temporaryIssue;
		const existing = this.readRecord(id);
		if (existing.status !== "ok") return existing;
		if (existing.record.status === "resolved") {
			return { status: "ok", record: existing.record, changed: false };
		}
		const now = this.timestamp();
		const timestamp = now < existing.record.updatedAt ? existing.record.updatedAt : now;
		const record: RecoveryIncident = {
			...existing.record,
			status: "resolved",
			updatedAt: timestamp,
			resolvedAt: timestamp,
			resolution,
		};
		this.writeRecord(record);
		return { status: "ok", record, changed: true };
	}

	/**
	 * Resolve from a closed set of verified native recovery actions. Fixed
	 * messages keep filesystem paths and failure details out of persisted state.
	 */
	resolveVerified(
		id: string,
		action: RecoveryVerifiedResolution,
	): RecoveryMutationResult | { status: "not_found"; id: string } {
		return this.resolve(id, VERIFIED_RESOLUTION_MESSAGES[action]);
	}

	private prepareRoot(): void {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const realRoot = realpathSync(this.root);
		for (const productRoot of this.productDataRoots) {
			let realProductRoot = productRoot;
			try {
				realProductRoot = realpathSync(productRoot);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
			}
			if (pathIsInside(realRoot, realProductRoot)) {
				throw new RecoveryStateValidationError(
					"Recovery state root must be outside product data roots",
				);
			}
		}
	}

	private timestamp(): string {
		const value = this.now();
		if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
			throw new RecoveryStateValidationError("Recovery state clock returned an invalid date");
		}
		return value.toISOString();
	}

	private recordPath(id: string): string {
		return resolve(this.root, `${id}.json`);
	}

	private temporaryPath(id: string): string {
		return `${this.recordPath(id)}.tmp`;
	}

	private cleanTemporaryFiles(): RecoveryRequiredResult[] {
		const issues: RecoveryRequiredResult[] = [];
		for (const entry of readdirSync(this.root, { withFileTypes: true })) {
			if (!entry.name.endsWith(".json.tmp")) continue;
			const id = entry.name.slice(0, -".json.tmp".length);
			const path = resolve(this.root, entry.name);
			if (!entry.isFile() || !ID_PATTERN.test(id)) {
				issues.push(this.malformed(ID_PATTERN.test(id) ? id : null, path));
				continue;
			}
			rmSync(path, { force: true });
			fsyncDirectory(this.root);
		}
		return issues;
	}

	private cleanTemporaryFile(id: string): RecoveryRequiredResult | null {
		const path = this.temporaryPath(id);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(path);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return null;
			throw error;
		}
		if (!stat.isFile()) return this.malformed(id, path);
		rmSync(path, { force: true });
		fsyncDirectory(this.root);
		return null;
	}

	private readRecord(id: string): RecoveryGetResult {
		const path = this.recordPath(id);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(path);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return { status: "not_found", id };
			throw error;
		}
		if (!stat.isFile()) return this.malformed(id, path);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		} catch {
			return this.malformed(id, path);
		}
		const record = validateStoredRecord(parsed);
		if (!record || record.id !== id) return this.malformed(id, path);
		return { status: "ok", record };
	}

	private malformed(id: string | null, path: string): RecoveryRequiredResult {
		return {
			status: "recovery_required",
			reason: "malformed_record",
			id,
			path,
			message: "Recovery state record is malformed and was preserved",
		};
	}

	private writeRecord(record: RecoveryIncident): void {
		const path = this.recordPath(record.id);
		const temporary = this.temporaryPath(record.id);
		let descriptor: number | undefined;
		try {
			descriptor = openSync(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
				0o600,
			);
			fchmodSync(descriptor, 0o600);
			writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(temporary, path);
			fsyncDirectory(this.root);
		} catch (error) {
			if (descriptor !== undefined) {
				try {
					closeSync(descriptor);
				} catch {
					// Preserve the write failure reported below.
				}
			}
			rmSync(temporary, { force: true });
			fsyncDirectory(this.root);
			throw error;
		}
	}
}
