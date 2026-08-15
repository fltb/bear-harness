import { describe, expect, it, vi } from "vitest";
import { installRendererFaultReporting } from "../src/index.js";

describe("renderer fault reporting", () => {
	it("classifies a typed error with line/column and forwards only metadata", () => {
		const report = vi.fn();
		installRendererFaultReporting(report);

		window.dispatchEvent(
			new ErrorEvent("error", { error: new TypeError("boom"), lineno: 12, colno: 3 }),
		);

		expect(report).toHaveBeenCalledWith({
			kind: "error",
			errorType: "TypeError",
			line: 12,
			column: 3,
		});
		// The message/stack must never leave the renderer.
		expect(report.mock.calls[0]?.[0]).not.toHaveProperty("message");
	});

	it("classifies an unhandled rejection reason by type only", () => {
		const report = vi.fn();
		installRendererFaultReporting(report);

		const event = new Event("unhandledrejection");
		Object.defineProperty(event, "reason", { value: new RangeError("out of range") });
		window.dispatchEvent(event);

		expect(report).toHaveBeenCalledWith({ kind: "unhandled-rejection", errorType: "RangeError" });
	});

	it("reports non-error values as non-error and unknown Error subclasses as unknown", () => {
		const report = vi.fn();
		installRendererFaultReporting(report);

		window.dispatchEvent(new ErrorEvent("error", { error: "just a string", lineno: 1, colno: 2 }));
		expect(report).toHaveBeenCalledWith({
			kind: "error",
			errorType: "non-error",
			line: 1,
			column: 2,
		});

		class CustomFault extends Error {
			name = "CustomFault";
		}
		window.dispatchEvent(
			new ErrorEvent("error", { error: new CustomFault("x"), lineno: 1, colno: 2 }),
		);
		expect(report).toHaveBeenCalledWith({
			kind: "error",
			errorType: "unknown",
			line: 1,
			column: 2,
		});
	});

	it("does nothing when no reporter is provided", () => {
		installRendererFaultReporting();
		expect(() => {
			window.dispatchEvent(new ErrorEvent("error", { error: new Error("x") }));
		}).not.toThrow();
	});
});
