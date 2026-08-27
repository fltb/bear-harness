// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
	diagnosticLevelEnabled,
	effectiveDiagnosticLevel,
	parseDiagnosticLevel,
} from "../../src/diagnostics/levels.js";

describe("diagnostic log levels", () => {
	it("parses the six supported levels case-insensitively", () => {
		expect(parseDiagnosticLevel(" TRACE ")).toBe("trace");
		expect(parseDiagnosticLevel("debug")).toBe("debug");
		expect(parseDiagnosticLevel("fatal")).toBe("fatal");
		expect(parseDiagnosticLevel("verbose")).toBeUndefined();
		expect(parseDiagnosticLevel(undefined)).toBeUndefined();
	});

	it("filters from the configured minimum level", () => {
		expect(diagnosticLevelEnabled("info", "debug")).toBe(false);
		expect(diagnosticLevelEnabled("info", "info")).toBe(true);
		expect(diagnosticLevelEnabled("info", "error")).toBe(true);
		expect(diagnosticLevelEnabled("trace", "debug")).toBe(true);
	});

	it("clamps packaged TRACE to DEBUG without weakening other levels", () => {
		expect(effectiveDiagnosticLevel("trace", true)).toBe("debug");
		expect(effectiveDiagnosticLevel("trace", false)).toBe("trace");
		expect(effectiveDiagnosticLevel("error", true)).toBe("error");
		expect(effectiveDiagnosticLevel(undefined, false)).toBe("info");
	});
});
