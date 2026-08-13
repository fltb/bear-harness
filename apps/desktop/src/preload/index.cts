/**
 * Sandbox preload for the Cyber Bear shell.
 *
 * Only `contextBridge` and `ipcRenderer` are imported. This single file
 * validates the renderer-fault envelope in the isolated world and attaches
 * the launch traceparent from `--bear-traceparent=<value>` (read from
 * `process.argv`, never exposed to the page).
 *
 * The preload must not depend on local or third-party modules: sandboxed
 * preloads only `require("electron")`.
 */

import { contextBridge, ipcRenderer } from "electron";

type ErrorType =
	| "Error"
	| "TypeError"
	| "RangeError"
	| "ReferenceError"
	| "SyntaxError"
	| "AggregateError"
	| "DOMException"
	| "non-error"
	| "unknown";

interface FaultInput {
	kind: "error" | "unhandled-rejection";
	errorType: ErrorType;
	line?: number;
	column?: number;
}

const TRACEPARENT_ARG_PREFIX = "--bear-traceparent=";
const traceparent: string =
	process.argv
		.find((arg) => arg.startsWith(TRACEPARENT_ARG_PREFIX))
		?.slice(TRACEPARENT_ARG_PREFIX.length) ?? "";

const FAULT_KEYS = ["kind", "errorType", "line", "column"] as const;
const ERROR_TYPES: readonly ErrorType[] = [
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"AggregateError",
	"DOMException",
	"non-error",
	"unknown",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
	);
}

/** Exact-shape validation: only known keys, valid kind/errorType, finite line/column. */
function validFault(input: unknown): input is FaultInput {
	if (!isPlainObject(input)) return false;
	for (const key of Object.keys(input)) {
		if (!(FAULT_KEYS as readonly string[]).includes(key)) return false;
	}
	if (input.kind !== "error" && input.kind !== "unhandled-rejection") return false;
	if (
		typeof input.errorType !== "string" ||
		!(ERROR_TYPES as readonly string[]).includes(input.errorType)
	) {
		return false;
	}
	for (const key of ["line", "column"]) {
		if (key in input) {
			const value = input[key];
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0 ||
				value > 2_147_483_647
			) {
				return false;
			}
		}
	}
	return true;
}

function reportRendererFault(input: unknown): void {
	if (!validFault(input)) return;
	ipcRenderer.send("diagnostics:renderer-fault:v1", { traceparent, fault: input });
}

contextBridge.exposeInMainWorld(
	"bearDesktop",
	Object.freeze({
		platform: process.platform,
		diagnostics: Object.freeze({
			reportRendererFault,
		}),
	}),
);
