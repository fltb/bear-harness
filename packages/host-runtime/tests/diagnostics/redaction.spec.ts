// @vitest-environment node

import { describe, expect, it } from "vitest";
import { redactTraceText } from "../../src/diagnostics/redaction.js";

describe("TRACE content redaction", () => {
	it("removes credentials and user-home segments before persistence", () => {
		const result = redactTraceText(
			'Authorization: Bearer secret-token api_key=sk-1234567890 {"password":"hidden"} path=/Users/alice/project and C:\\Users\\bob\\repo plus /private/tmp/work/item.txt',
		);
		expect(result.content).not.toContain("secret-token");
		expect(result.content).not.toContain("sk-1234567890");
		expect(result.content).not.toContain("alice");
		expect(result.content).not.toContain("bob");
		expect(result.content).not.toContain("hidden");
		expect(result.content).not.toContain("item.txt");
		expect(result.content).not.toContain("project");
		expect(result.content).not.toContain("repo");
		expect(result.content).toContain("[REDACTED_SECRET]");
		expect(result.content).toContain("[REDACTED_HOME]");
		expect(result.content).toContain("[REDACTED_PATH]");
	});

	it("truncates on a UTF-8 boundary and preserves original byte count", () => {
		const input = "极".repeat(20);
		const result = redactTraceText(input, 10);
		expect(result.originalBytes).toBe(60);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(10);
		expect(result.content).not.toContain("�");
	});
});
