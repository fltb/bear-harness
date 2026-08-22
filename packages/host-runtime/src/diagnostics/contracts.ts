/**
 * Diagnostics v1 contracts: the single source of truth for the diagnostics
 * policy and the event/span catalog, plus runtime exact-shape validation.
 *
 * Everything here uses only erasable TypeScript so the contract checker
 * (`scripts/check-diagnostics-contracts.mjs`) can import this file directly
 * with Node 24 type stripping.
 *
 * The catalog is the ONLY write entry point: there is no free-text logging
 * API. Each entry fixes kind/level/origin and the exact attribute keys with
 * their primitive types, ranges or enums. Records are validated again at
 * runtime before serialization — TypeScript types are not a security boundary.
 */

export type DiagnosticKind = "event" | "span";
export type DiagnosticLevel = "info" | "warn" | "error" | "fatal";
export type DiagnosticOrigin = "main" | "renderer" | "electron";
export type SpanStatus = "ok" | "error" | "cancelled";

export interface DiagnosticsPolicy {
	readonly localOnly: true;
	readonly contentMode: "metadata-only";
	readonly maxAgeDays: 30;
	readonly maxBytes: 209715200;
	readonly segmentBytes: 5242880;
	readonly queueMaxRecords: 500;
	readonly queueMaxBytes: 1048576;
	readonly shutdownFlushMs: 2000;
	readonly rendererFaultsPerMinute: 20;
	readonly crashUpload: false;
}

/**
 * Pinned diagnostics policy. `localOnly` and `contentMode` are part of the
 * privacy contract: diagnostics never leave this machine and JSONL records
 * contain metadata only. Not configurable via environment or fork config.
 */
export const DIAGNOSTICS_POLICY: Readonly<DiagnosticsPolicy> = Object.freeze({
	localOnly: true,
	contentMode: "metadata-only",
	maxAgeDays: 30,
	maxBytes: 209715200,
	segmentBytes: 5242880,
	queueMaxRecords: 500,
	queueMaxBytes: 1048576,
	shutdownFlushMs: 2000,
	rendererFaultsPerMinute: 20,
	crashUpload: false,
});

export const MAX_RECORD_BYTES = 16384;
export const MAX_ATTRIBUTE_KEYS = 16;
export const MAX_STRING_BYTES = 128;

export type AttributeSpec =
	| { readonly type: "boolean"; readonly optional?: boolean }
	| {
			readonly type: "integer";
			readonly min: number;
			readonly max: number;
			readonly optional?: boolean;
	  }
	| {
			readonly type: "string";
			readonly enum?: readonly string[];
			readonly maxBytes?: number;
			readonly optional?: boolean;
	  };

export interface CatalogEntry {
	readonly kind: DiagnosticKind;
	readonly level: DiagnosticLevel;
	readonly origin: DiagnosticOrigin;
	readonly attributes: Readonly<Record<string, AttributeSpec>>;
}

const str = (maxBytes = MAX_STRING_BYTES): AttributeSpec => ({ type: "string", maxBytes });
const strEnum = (values: readonly string[]): AttributeSpec => ({ type: "string", enum: values });
const int = (min: number, max: number, optional = false): AttributeSpec => ({
	type: "integer",
	min,
	max,
	optional,
});
const bool = (optional = false): AttributeSpec => ({ type: "boolean", optional });

export const RENDERER_FAULT_KINDS = ["error", "unhandled-rejection"] as const;
export const RENDERER_ERROR_TYPES = [
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"AggregateError",
	"DOMException",
	"non-error",
	"unknown",
] as const;
export const PROCESS_GONE_REASONS = [
	"clean-exit",
	"abnormal-exit",
	"killed",
	"crashed",
	"oom",
	"launch-failed",
	"integrity-failure",
	"unknown",
] as const;
export const CHILD_PROCESS_TYPES = [
	"utility",
	"renderer",
	"zygote",
	"gpu",
	"gpu-broker",
	"sandbox-helper",
	"pepper-plugin-helper",
	"crashpad-handler",
	"unknown",
] as const;
export const INPUT_REJECT_REASONS = [
	"sender",
	"shape",
	"frame",
	"url",
	"rate",
	"traceparent",
	"record",
	"oversized",
] as const;
export const RETENTION_DEFER_REASONS = ["active"] as const;
export const WRITER_FAILURE_KINDS = ["write"] as const;
export const RPC_ERROR_CATEGORIES = [
	"unauthorized",
	"body_too_large",
	"malformed_json",
	"invalid_request",
	"unknown_channel",
	"internal_error",
	"rpc_error",
] as const;

export const PLATFORMS = ["darwin", "win32", "linux"] as const;

/**
 * Fixed event/span catalog, indexed by name. The five completed spans are
 * app.session, diagnostics.prune, window.session, window.load and rpc.request;
 * span records carry level "error" when their status is "error", otherwise the
 * base level.
 */
export const DIAGNOSTIC_CATALOG: Readonly<Record<string, CatalogEntry>> = deepFreeze({
	// ---- completed spans ----
	"app.session": {
		kind: "span",
		level: "info",
		origin: "main",
		attributes: {
			launchId: str(),
			pid: int(1, Number.MAX_SAFE_INTEGER),
			platform: strEnum(PLATFORMS),
			packaged: bool(),
		},
	},
	"diagnostics.prune": {
		kind: "span",
		level: "info",
		origin: "main",
		attributes: {
			inactiveUnits: int(0, Number.MAX_SAFE_INTEGER),
			deletedUnits: int(0, Number.MAX_SAFE_INTEGER),
			deletedBytes: int(0, Number.MAX_SAFE_INTEGER),
			deferred: bool(),
		},
	},
	"window.session": {
		kind: "span",
		level: "info",
		origin: "main",
		attributes: { webContentsId: int(1, Number.MAX_SAFE_INTEGER) },
	},
	"window.load": {
		kind: "span",
		level: "info",
		origin: "main",
		attributes: { webContentsId: int(1, Number.MAX_SAFE_INTEGER), ok: bool() },
	},
	"rpc.request": {
		kind: "span",
		level: "info",
		origin: "main",
		attributes: {
			channel: str(),
			errorCategory: { type: "string", enum: RPC_ERROR_CATEGORIES, optional: true },
		},
	},
	// ---- events ----
	"app.started": {
		kind: "event",
		level: "info",
		origin: "main",
		attributes: {
			pid: int(1, Number.MAX_SAFE_INTEGER),
			platform: strEnum(PLATFORMS),
			packaged: bool(),
		},
	},
	"app.previous_exit_unclean": {
		kind: "event",
		level: "warn",
		origin: "main",
		attributes: { count: int(1, Number.MAX_SAFE_INTEGER) },
	},
	"app.shutdown_timeout": {
		kind: "event",
		level: "error",
		origin: "main",
		attributes: {},
	},
	"diagnostics.retention_deferred": {
		kind: "event",
		level: "warn",
		origin: "main",
		attributes: { reason: strEnum(RETENTION_DEFER_REASONS) },
	},
	"diagnostics.writer_recovered": {
		kind: "event",
		level: "warn",
		origin: "main",
		attributes: {
			failureKind: strEnum(WRITER_FAILURE_KINDS),
			bufferedRecords: int(0, Number.MAX_SAFE_INTEGER),
			droppedRecords: int(0, Number.MAX_SAFE_INTEGER),
		},
	},
	"diagnostics.input_rejected": {
		kind: "event",
		level: "warn",
		origin: "main",
		attributes: { reason: strEnum(INPUT_REJECT_REASONS) },
	},
	"diagnostics.trace_restarted": {
		kind: "event",
		level: "warn",
		origin: "main",
		attributes: {},
	},
	"window.load_failed": {
		kind: "event",
		level: "error",
		origin: "electron",
		attributes: { webContentsId: int(1, Number.MAX_SAFE_INTEGER) },
	},
	"window.unresponsive": {
		kind: "event",
		level: "warn",
		origin: "electron",
		attributes: { webContentsId: int(1, Number.MAX_SAFE_INTEGER) },
	},
	"window.responsive": {
		kind: "event",
		level: "info",
		origin: "electron",
		attributes: { webContentsId: int(1, Number.MAX_SAFE_INTEGER) },
	},
	"preload.failed": {
		kind: "event",
		level: "error",
		origin: "electron",
		attributes: { webContentsId: int(1, Number.MAX_SAFE_INTEGER) },
	},
	"renderer.fault": {
		kind: "event",
		level: "error",
		origin: "renderer",
		attributes: {
			kind: strEnum(RENDERER_FAULT_KINDS),
			errorType: strEnum(RENDERER_ERROR_TYPES),
			line: int(0, 2147483647, true),
			column: int(0, 2147483647, true),
		},
	},
	"renderer.process_gone": {
		kind: "event",
		level: "error",
		origin: "electron",
		attributes: { reason: strEnum(PROCESS_GONE_REASONS) },
	},
	"electron.child_process_gone": {
		kind: "event",
		level: "error",
		origin: "electron",
		attributes: {
			type: strEnum(CHILD_PROCESS_TYPES),
			reason: strEnum(PROCESS_GONE_REASONS),
		},
	},
	"main.uncaught_exception": {
		kind: "event",
		level: "fatal",
		origin: "main",
		attributes: {},
	},
});

export type DiagnosticName = keyof typeof DIAGNOSTIC_CATALOG;

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value as Record<string, unknown>)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
	}
	return value;
}

export interface DiagnosticRecordV1 {
	schemaVersion: 1;
	timestamp: string;
	sequence: number;
	launchId: string;
	kind: DiagnosticKind;
	level: DiagnosticLevel;
	name: string;
	origin: DiagnosticOrigin;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	durationMs?: number;
	status?: SpanStatus;
	attributes: Record<string, boolean | number | string>;
}

/** A record before the writer completes timestamp/sequence/launchId. */
export interface PendingRecord {
	name: string;
	kind: DiagnosticKind;
	level: DiagnosticLevel;
	origin: DiagnosticOrigin;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	durationMs?: number;
	status?: SpanStatus;
	attributes: Record<string, boolean | number | string>;
}

const TOP_LEVEL_KEYS = new Set([
	"schemaVersion",
	"timestamp",
	"sequence",
	"launchId",
	"kind",
	"level",
	"name",
	"origin",
	"traceId",
	"spanId",
	"parentSpanId",
	"durationMs",
	"status",
	"attributes",
]);

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
	);
}

function isValidUtcIso(timestamp: unknown): timestamp is string {
	if (typeof timestamp !== "string") return false;
	return (
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) &&
		!Number.isNaN(Date.parse(timestamp))
	);
}

/** Validate a fully completed record (used by the writer and by tests). */
export function validateRecord(record: unknown): string[] {
	const errors: string[] = [];
	if (!isPlainObject(record)) return ["record must be a plain object"];

	for (const key of Object.keys(record)) {
		if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown top-level key ${JSON.stringify(key)}`);
	}

	if (record.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	if (!isValidUtcIso(record.timestamp)) errors.push("timestamp must be a UTC ISO-8601 string");
	if (
		typeof record.sequence !== "number" ||
		!Number.isSafeInteger(record.sequence) ||
		record.sequence < 1
	) {
		errors.push("sequence must be a positive safe integer");
	}
	if (typeof record.launchId !== "string" || record.launchId.length === 0) {
		errors.push("launchId must be a non-empty string");
	}

	const kind = record.kind;
	if (kind !== "event" && kind !== "span") errors.push("kind must be event or span");
	const level = record.level;
	if (!["info", "warn", "error", "fatal"].includes(level as string)) {
		errors.push("level must be info|warn|error|fatal");
	}
	const origin = record.origin;
	if (!["main", "renderer", "electron"].includes(origin as string)) {
		errors.push("origin must be main|renderer|electron");
	}
	const name = record.name;
	if (typeof name !== "string" || !(name in DIAGNOSTIC_CATALOG)) {
		errors.push(`name must be a known catalog entry, got ${JSON.stringify(name)}`);
	}

	if (typeof record.traceId !== "string" || !HEX32.test(record.traceId)) {
		errors.push("traceId must be 32 lowercase hex digits");
	}
	if (typeof record.spanId !== "string" || !HEX16.test(record.spanId)) {
		errors.push("spanId must be 16 lowercase hex digits");
	}
	if (
		record.parentSpanId !== undefined &&
		(typeof record.parentSpanId !== "string" || !HEX16.test(record.parentSpanId))
	) {
		errors.push("parentSpanId must be 16 lowercase hex digits when present");
	}
	if (
		record.durationMs !== undefined &&
		(typeof record.durationMs !== "number" ||
			!Number.isSafeInteger(record.durationMs) ||
			record.durationMs < 0)
	) {
		errors.push("durationMs must be a non-negative safe integer when present");
	}
	if (
		record.status !== undefined &&
		!["ok", "error", "cancelled"].includes(record.status as string)
	) {
		errors.push("status must be ok|error|cancelled when present");
	}
	if (kind === "span" && (record.status === undefined || record.durationMs === undefined)) {
		errors.push("span records require status and durationMs");
	}
	if (kind === "event" && (record.status !== undefined || record.durationMs !== undefined)) {
		errors.push("event records must not carry status or durationMs");
	}

	const entry =
		typeof name === "string"
			? (DIAGNOSTIC_CATALOG as Record<string, CatalogEntry | undefined>)[name]
			: undefined;
	if (entry) {
		errors.push(...validateAttributes(record.attributes, entry));
	} else if (record.attributes !== undefined) {
		errors.push("attributes must be a plain object");
	}
	return errors;
}

/** Validate an attributes object against a catalog entry's attribute specs. */
export function validateAttributes(attributes: unknown, entry: CatalogEntry): string[] {
	const errors: string[] = [];
	if (!isPlainObject(attributes)) {
		return ["attributes must be a plain object"];
	}
	const keys = Object.keys(attributes);
	if (keys.length > MAX_ATTRIBUTE_KEYS) {
		errors.push(`attributes must have at most ${MAX_ATTRIBUTE_KEYS} keys`);
	}
	for (const key of keys) {
		const spec = entry.attributes[key];
		if (!spec) {
			errors.push(
				`unknown attribute key ${JSON.stringify(key)} for ${entry.kind} ${JSON.stringify(key)}`,
			);
			continue;
		}
		const value = attributes[key];
		switch (spec.type) {
			case "boolean":
				if (typeof value !== "boolean") errors.push(`${key} must be a boolean`);
				break;
			case "integer":
				if (
					typeof value !== "number" ||
					!Number.isSafeInteger(value) ||
					value < spec.min ||
					value > spec.max
				) {
					errors.push(`${key} must be a safe integer within [${spec.min}, ${spec.max}]`);
				}
				break;
			case "string": {
				if (typeof value !== "string") {
					errors.push(`${key} must be a string`);
					break;
				}
				if (spec.enum && !spec.enum.includes(value)) {
					errors.push(`${key} must be one of ${spec.enum.join("|")}`);
				}
				if (spec.maxBytes && Buffer.byteLength(value, "utf8") > spec.maxBytes) {
					errors.push(`${key} must be at most ${spec.maxBytes} UTF-8 bytes`);
				}
				break;
			}
		}
	}
	for (const [key, spec] of Object.entries(entry.attributes)) {
		if (!spec.optional && !(key in attributes)) {
			errors.push(`missing required attribute ${key}`);
		}
	}
	return errors;
}

export function isErrorType(value: unknown): value is (typeof RENDERER_ERROR_TYPES)[number] {
	return typeof value === "string" && (RENDERER_ERROR_TYPES as readonly string[]).includes(value);
}
