import type { DiagnosticLevel } from "./contracts.js";

export const DIAGNOSTIC_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

const LEVEL_RANK: Readonly<Record<DiagnosticLevel, number>> = Object.freeze({
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
	fatal: 5,
});

export function parseDiagnosticLevel(value: unknown): DiagnosticLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return (DIAGNOSTIC_LEVELS as readonly string[]).includes(normalized)
		? (normalized as DiagnosticLevel)
		: undefined;
}

export function diagnosticLevelEnabled(
	minimum: DiagnosticLevel,
	candidate: DiagnosticLevel,
): boolean {
	return LEVEL_RANK[candidate] >= LEVEL_RANK[minimum];
}

/** Packaged builds honor the same explicit level policy as development builds. */
export function effectiveDiagnosticLevel(
	requested: DiagnosticLevel | undefined,
	_packaged: boolean,
): DiagnosticLevel {
	return requested ?? "info";
}
