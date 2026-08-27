import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const entry = {
	id: "entry-1",
	kind: "fact",
	scope: "self" as const,
	text: "用户喜欢在夜里工作",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	importance: 0.8,
};

const pendingCandidate = {
	id: "candidate-1",
	kind: "fact" as const,
	sourceKind: "extractor" as const,
	normalizedText: "用户每天七点起床",
	why: "从对话中抽取：用户提到作息规律",
	suggestedScope: "self" as const,
	status: "pending" as const,
	createdAt: "2026-01-02T00:00:00.000Z",
};

async function openMemoryTab(
	client: ReturnType<typeof createTestClient>["client"],
	excluded = () => false,
) {
	const user = userEvent.setup();
	client.memory.list = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { entries: [{ ...entry, excluded: excluded() }] } }),
	);
	render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
	await user.click(await screen.findByRole("button", { name: zhCN.sidebar.characterSettings }));
	const backstage = await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings });
	await user.click(within(backstage).getByRole("tab", { name: zhCN.backstage.memory }));
	return { user, backstage };
}

describe("memory per-entry exclude and pending candidates", () => {
	it("renders exclusion from the refreshed Host projection", async () => {
		const { client } = createTestClient();
		let excluded = false;
		const exclude = vi.fn((params: { excluded: boolean }) => {
			excluded = params.excluded;
			return Promise.resolve({ ok: true as const, data: null });
		});
		client.memory.exclude = exclude;
		const { user, backstage } = await openMemoryTab(client, () => excluded);

		const region = await within(backstage).findByRole("region", {
			name: zhCN.memory.defaultEntriesTitle,
		});
		const item = within(region).getByText(entry.text).closest("li") as HTMLElement;
		const toggle = within(region).getByRole("button", { name: zhCN.memory.exclude });
		await user.click(toggle);

		await waitFor(() =>
			expect(exclude).toHaveBeenCalledWith({ memoryId: "entry-1", excluded: true }),
		);
		await waitFor(() =>
			expect(within(region).getByRole("button", { name: zhCN.memory.included })).toBeVisible(),
		);
		expect(within(region).getByText(zhCN.memory.excludedNote)).toBeVisible();

		await user.click(within(region).getByRole("button", { name: zhCN.memory.included }));
		await waitFor(() =>
			expect(exclude).toHaveBeenCalledWith({ memoryId: "entry-1", excluded: false }),
		);
		expect(within(region).queryByText(zhCN.memory.excludedNote)).not.toBeInTheDocument();
	});

	it("surfaces exclude failures in the entry panel", async () => {
		const { client } = createTestClient();
		client.memory.exclude = vi.fn(() => Promise.reject(new Error("exclude write failed")));
		const { user, backstage } = await openMemoryTab(client);

		const region = await within(backstage).findByRole("region", {
			name: zhCN.memory.defaultEntriesTitle,
		});
		const item = within(region).getByText(entry.text).closest("li") as HTMLElement;
		await user.click(within(item).getByRole("button", { name: zhCN.memory.exclude }));

		await waitFor(() =>
			expect(within(region).getByRole("alert")).toHaveTextContent("exclude write failed"),
		);
		expect(within(item).queryByText(zhCN.memory.excludedNote)).not.toBeInTheDocument();
	});

	it("lists pending candidates and rejects one without edits", async () => {
		const { client } = createTestClient();
		const candidatesList = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { candidates: [pendingCandidate] } }),
		);
		const reject = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		client.memory.candidatesList = candidatesList;
		client.memory.candidateReject = reject;
		const { user, backstage } = await openMemoryTab(client);

		const section = await within(backstage).findByRole("region", {
			name: zhCN.memory.candidatesTitle,
		});
		await waitFor(() => expect(candidatesList).toHaveBeenCalledWith({ status: undefined }));
		expect(within(section).getByText(pendingCandidate.normalizedText)).toBeVisible();
		expect(within(section).getByText(pendingCandidate.why)).toBeVisible();

		await user.click(within(section).getByRole("button", { name: zhCN.memory.candidateReject }));
		await waitFor(() => expect(reject).toHaveBeenCalledWith({ candidateId: "candidate-1" }));
	});

	it("approves a candidate with edited text and a decided scope", async () => {
		const { client } = createTestClient();
		client.memory.candidatesList = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { candidates: [pendingCandidate] } }),
		);
		const approve = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		client.memory.candidateApprove = approve;
		const { user, backstage } = await openMemoryTab(client);

		const section = await within(backstage).findByRole("region", {
			name: zhCN.memory.candidatesTitle,
		});
		const card = within(section)
			.getByText(pendingCandidate.normalizedText)
			.closest("li") as HTMLElement;

		const editor = within(card).getByRole("textbox", { name: zhCN.memory.candidateEditedContent });
		await user.clear(editor);
		await user.type(editor, "用户每天七点前起床");
		await selectKobalteOption(
			user,
			within(card).getByRole("button", { name: new RegExp(zhCN.memory.candidateScope) }),
			zhCN.memory.scopes.scene,
		);
		await user.click(within(card).getByRole("button", { name: zhCN.memory.candidateApprove }));

		await waitFor(() =>
			expect(approve).toHaveBeenCalledWith({
				candidateId: "candidate-1",
				editedText: "用户每天七点前起床",
				decidedScope: "scene",
			}),
		);
	});

	it("approves a candidate unchanged without sending editedText", async () => {
		const { client } = createTestClient();
		client.memory.candidatesList = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { candidates: [pendingCandidate] } }),
		);
		const approve = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		client.memory.candidateApprove = approve;
		const { user, backstage } = await openMemoryTab(client);

		const section = await within(backstage).findByRole("region", {
			name: zhCN.memory.candidatesTitle,
		});
		const card = within(section)
			.getByText(pendingCandidate.normalizedText)
			.closest("li") as HTMLElement;
		await user.click(within(card).getByRole("button", { name: zhCN.memory.candidateApprove }));

		await waitFor(() =>
			expect(approve).toHaveBeenCalledWith({
				candidateId: "candidate-1",
				editedText: undefined,
				decidedScope: "self",
			}),
		);
	});
});
