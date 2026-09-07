// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const parseOffice = vi.hoisted(() => vi.fn());
vi.mock("officeparser", () => ({ OfficeParser: { parseOffice } }));

import { registerHostTools } from "../src/companion/host-tool-register.js";

describe("document_read", () => {
	beforeEach(() => parseOffice.mockReset());

	it("can mask all External Run tools without changing their implementation", () => {
		const tools = registerHostTools({} as never, { externalRuns: false });

		expect(tools.host_delegate).toBeUndefined();
		expect(tools.host_run_read).toBeUndefined();
		expect(tools.host_run_control).toBeUndefined();
		expect(tools.host_state).toBeDefined();
	});

	it("reads an Office document path without creating attachment state", async () => {
		parseOffice.mockResolvedValue({
			to: vi.fn().mockResolvedValue({ value: "# Brief\nalpha beta gamma" }),
		});
		const tools = registerHostTools({} as never);
		const result = await tools.document_read?.execute("call-1", {
			path: "/tmp/brief.docx",
			offset: 8,
			limit: 5,
		});
		expect(parseOffice).toHaveBeenCalledWith(
			"/tmp/brief.docx",
			expect.objectContaining({ extractAttachments: false, ocr: false }),
		);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "alpha" }],
			details: { ok: true, data: { path: "/tmp/brief.docx", nextOffset: 13 } },
		});
	});

	it("rejects unsupported extensions before invoking the parser", async () => {
		const tools = registerHostTools({} as never);
		const result = await tools.document_read?.execute("call-2", { path: "/tmp/photo.png" });
		expect(parseOffice).not.toHaveBeenCalled();
		expect(result).toMatchObject({ details: { ok: false, code: "document_type_unsupported" } });
	});

	it("rejects relative document and delegated input paths", async () => {
		const delegate = vi.fn();
		const tools = registerHostTools({ delegate } as never);
		const document = await tools.document_read?.execute("relative-document", {
			path: "brief.docx",
		});
		const delegated = await tools.host_delegate?.execute("relative-delegate", {
			instruction: "Read it",
			inputPaths: ["brief.docx"],
		});
		expect(document).toMatchObject({
			details: { ok: false, code: "document_path_not_absolute" },
		});
		expect(delegated).toMatchObject({
			details: { ok: false, code: "delegate_input_path_not_absolute" },
		});
		expect(delegate).not.toHaveBeenCalled();
	});

	it("returns the accepted Pi Run identity in model-visible content", async () => {
		const delegate = vi.fn().mockResolvedValue({ accepted: true, runId: "run-1", executor: "pi" });
		const tools = registerHostTools({
			sessionId: () => "session-1",
			entryId: () => "entry-1",
			delegate,
		} as never);
		const result = await tools.host_delegate?.execute("call-3", {
			instruction: "Summarize the workbook",
			inputPaths: ["/tmp/data.xlsx"],
		});
		expect(delegate).toHaveBeenCalledWith({
			conversationId: "session-1",
			triggerEntryId: "entry-1",
			toolCallId: "call-3",
			instruction: "Summarize the workbook",
			inputPaths: ["/tmp/data.xlsx"],
		});
		const text = result?.content[0];
		expect(text?.type).toBe("text");
		expect(JSON.parse(text?.type === "text" ? text.text : "")).toEqual({
			accepted: true,
			runId: "run-1",
			executor: "pi",
		});
		expect(result?.details).toMatchObject({
			ok: true,
			data: { accepted: true, runId: "run-1", executor: "pi" },
		});
	});

	it("rejects model-selected executors and model-supplied admission identities", async () => {
		const delegate = vi.fn();
		const tools = registerHostTools({ delegate } as never);
		for (const extra of [
			{ agent: "codex" },
			{ toolCallId: "forged" },
			{ conversationId: "other" },
		]) {
			const result = await tools.host_delegate?.execute("native-call", {
				instruction: "Read the file",
				...extra,
			});
			expect(result?.details).toMatchObject({ ok: false, code: "host_tool_arguments_invalid" });
		}
		expect(delegate).not.toHaveBeenCalled();
	});

	it("preserves plain Host admission errors without object stringification", async () => {
		const tools = registerHostTools({
			sessionId: () => "session-1",
			entryId: () => "entry-1",
			delegate: async () => {
				throw {
					kind: "validation_failed",
					reason: "input_missing",
					message: "The input file is missing.",
				};
			},
		} as never);
		const result = await tools.host_delegate?.execute("native-call", { instruction: "Read it" });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "The input file is missing." }],
			details: { ok: false, code: "input_missing", message: "The input file is missing." },
		});
	});
});

describe("conversation-owned Run tools", () => {
	it("requires exact control targets and excludes model permission approvals", async () => {
		const runControl = vi.fn();
		const tools = registerHostTools({ runControl } as never);
		for (const args of [
			{ action: "cancel" },
			{ action: "respondPermission", runId: "run-1", optionId: "allow" },
			{ action: "steer", runId: "run-1" },
			{ action: "cancel", runId: "run-1", conversationId: "other" },
		]) {
			const result = await tools.host_run_control?.execute("control", args);
			expect(result?.details).toMatchObject({ ok: false, code: "host_tool_arguments_invalid" });
		}
		expect(runControl).not.toHaveBeenCalled();
	});

	it("preserves ownership denials from both Run callbacks", async () => {
		const denied = {
			reason: "run_conversation_mismatch",
			message: "This Run belongs to another conversation.",
		};
		const runRead = vi.fn().mockRejectedValue(denied);
		const runControl = vi.fn().mockRejectedValue(denied);
		const tools = registerHostTools({
			sessionId: () => "invoking-session",
			runRead,
			runControl,
		} as never);
		const read = await tools.host_run_read?.execute("read", { runId: "foreign-run" });
		const control = await tools.host_run_control?.execute("cancel", {
			action: "cancel",
			runId: "foreign-run",
		});
		for (const result of [read, control]) {
			expect(result).toMatchObject({
				content: [{ type: "text", text: denied.message }],
				details: { ok: false, code: denied.reason, message: denied.message },
			});
		}
		expect(runRead).toHaveBeenCalledWith("invoking-session", "foreign-run");
		expect(runControl).toHaveBeenCalledWith("invoking-session", {
			action: "cancel",
			runId: "foreign-run",
		});
	});
});

describe("read_image fallback skill tool", () => {
	it("is exposed only when a fallback reader is supplied and returns its description", async () => {
		const imageRead = vi.fn().mockResolvedValue({
			path: "/tmp/photo.png",
			mimeType: "image/png",
			description: "A white bear beside a window.",
		});
		const tools = registerHostTools({ imageRead } as never);
		expect(tools.read_image).toBeDefined();
		const result = await tools.read_image?.execute("image-1", { path: "/tmp/photo.png" });
		expect(imageRead).toHaveBeenCalledWith("/tmp/photo.png");
		expect(result).toMatchObject({
			details: { ok: true, data: { description: "A white bear beside a window." } },
		});
		expect(registerHostTools({} as never).read_image).toBeUndefined();
	});
});
