// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const parseOffice = vi.hoisted(() => vi.fn());
vi.mock("officeparser", () => ({ OfficeParser: { parseOffice } }));

import { registerHostTools } from "../src/companion/host-tool-register.js";

describe("document_read", () => {
	beforeEach(() => parseOffice.mockReset());

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
			agent: "codex",
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

	it("delegates user-supplied paths using the current Pi identifiers", async () => {
		const delegate = vi.fn().mockResolvedValue({ runId: "run-1", status: "running" });
		const tools = registerHostTools({
			sessionId: () => "session-1",
			entryId: () => "entry-1",
			delegate,
		} as never);
		await tools.host_delegate?.execute("call-3", {
			agent: "codex",
			instruction: "Summarize the workbook",
			inputPaths: ["/tmp/data.xlsx"],
		});
		expect(delegate).toHaveBeenCalledWith({
			conversationId: "session-1",
			triggerEntryId: "entry-1",
			agent: "codex",
			instruction: "Summarize the workbook",
			inputPaths: ["/tmp/data.xlsx"],
		});
	});
});
