import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { codexAcpDialect, standardAcpDialect } from "../src/executors/acp-dialect.js";

function chunk(text: string, phase: string, messageId: string): SessionUpdate {
	return {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
		messageId,
		_meta: { codex: { phase } },
	};
}
it("takes Codex's explicit final answer without mixing progress or earlier final messages", () => {
	const reader = codexAcpDialect.result();
	reader.update(chunk("progress".repeat(10000), "commentary", "a"));
	reader.update(chunk("old final", "final_answer", "b"));
	reader.update(chunk("Result ", "final_answer", "c"));
	reader.update(chunk("ready", "final_answer", "c"));
	expect(reader.finish({ stopReason: "end_turn" })).toBe("Result ready");
	reader.reset();
	expect(() => reader.finish({ stopReason: "end_turn" })).toThrow();
});
it("marks a bounded final excerpt explicitly and never promotes generic ACP progress to a final answer", () => {
	const reader = codexAcpDialect.result();
	reader.update(chunk("x".repeat(70000), "final_answer", "a"));
	expect(reader.finish({ stopReason: "end_turn" })).toBe(
		`[Final answer excerpt]\n${"x".repeat(65536)}`,
	);
	const generic = standardAcpDialect.result();
	generic.update(chunk("Working...", "commentary", "a"));
	expect(generic.finish({ stopReason: "end_turn" })).toBeUndefined();
});

it("does not mark a Codex provider error or progress-only turn as successful", () => {
	const reader = codexAcpDialect.result();
	reader.update({
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: "The configured model requires a newer Codex version." },
	});
	expect(() => reader.finish({ stopReason: "end_turn" })).toThrow(
		expect.objectContaining({ reason: "runner_final_result_missing" }),
	);
});
