/**
 * Renderer-side fault reporting for diagnostics v1.
 *
 * The `error`/`unhandledrejection` listeners classify ONLY the Error type,
 * the event kind and finite line/column numbers. They never read or forward
 * message text, stacks, rejection reasons or source URLs, and they never
 * call `preventDefault()`. Reporting goes through the preload bridge which
 * re-validates the envelope in the isolated world.
 */

type RendererErrorType =
	| "Error"
	| "TypeError"
	| "RangeError"
	| "ReferenceError"
	| "SyntaxError"
	| "AggregateError"
	| "DOMException"
	| "non-error"
	| "unknown";

interface RendererFault {
	kind: "error" | "unhandled-rejection";
	errorType: RendererErrorType;
	line?: number;
	column?: number;
}

const ERROR_TYPE_BY_NAME: Record<string, RendererErrorType> = {
	Error: "Error",
	TypeError: "TypeError",
	RangeError: "RangeError",
	ReferenceError: "ReferenceError",
	SyntaxError: "SyntaxError",
	AggregateError: "AggregateError",
	DOMException: "DOMException",
};

function classifyErrorType(value: unknown): RendererErrorType {
	if (typeof DOMException !== "undefined" && value instanceof DOMException) return "DOMException";
	if (value instanceof Error) {
		const name = typeof value.name === "string" ? value.name : "";
		return ERROR_TYPE_BY_NAME[name] ?? "unknown";
	}
	return "non-error";
}

function finiteLineColumn(value: number): number | undefined {
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function report(input: RendererFault): void {
	const bridge = window.bearDesktop;
	if (!bridge || typeof bridge.diagnostics?.reportRendererFault !== "function") return;
	bridge.diagnostics.reportRendererFault(input);
}

export function installRendererFaultReporting(): void {
	window.addEventListener("error", (event) => {
		report({
			kind: "error",
			errorType: classifyErrorType(event.error),
			...(finiteLineColumn(event.lineno) !== undefined ? { line: event.lineno } : {}),
			...(finiteLineColumn(event.colno) !== undefined ? { column: event.colno } : {}),
		});
	});

	window.addEventListener("unhandledrejection", (event) => {
		report({ kind: "unhandled-rejection", errorType: classifyErrorType(event.reason) });
	});
}
