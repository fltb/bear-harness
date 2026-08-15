import { productUi } from "@bear-harness/product-config";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

const COMPLETE_ONBOARDING = {
	status: "complete" as const,
	eventSeq: 0,
	stateData: { schema_version: 1 as const, flow_version: 1, answers: {}, decisions: {} },
};

const candidate = {
	id: "candidate-1",
	kind: "fact" as const,
	scope: "self" as const,
	text: "用户喜欢在夜里工作",
	why: "来自明确陈述",
	status: "pending" as const,
	createdAt: "2026-01-01T00:00:00.000Z",
};

const entry = {
	id: "entry-1",
	kind: "fact",
	scope: "self" as const,
	text: "用户喜欢在夜里工作",
	normalizedText: "用户喜欢在夜里工作",
	sourceConversationTitle: "测试对话",
	pinned: false,
	createdAt: "2026-01-01T00:00:00.000Z",
};

describe("memory controls", () => {
	it("routes candidate approval, entry pinning and scoped search through the injected Host client", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const decideCandidate = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const pin = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const search = vi.fn(() => Promise.resolve({ ok: true as const, data: { entries: [entry] } }));
		client.memory.listCandidates = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { candidates: [candidate] } }),
		);
		client.memory.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { entries: [entry] } }),
		);
		client.memory.decideCandidate = decideCandidate;
		client.memory.pin = pin;
		client.memory.search = search;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					onboarding: COMPLETE_ONBOARDING,
					memory: { candidates: [candidate], entries: [entry] },
				},
			}),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: productUi.titlebar.backstage }));
		await user.click(screen.getByRole("tab", { name: productUi.backstage.memory }));
		await screen.findAllByText(candidate.text);
		await user.click(screen.getByRole("button", { name: productUi.memory.remember }));
		await user.click(screen.getByRole("button", { name: productUi.memory.pin }));
		const query = screen.getByRole("searchbox", { name: productUi.memory.searchLabel });
		await user.type(query, "夜里");
		await user.click(screen.getByRole("button", { name: productUi.memory.search }));

		await waitFor(() => {
			expect(decideCandidate).toHaveBeenCalledWith("candidate-1", "approve", undefined, "self");
			expect(pin).toHaveBeenCalledWith("entry-1", true);
			expect(search).toHaveBeenCalledWith("夜里", "self");
		});
	});

	it("edits an approved entry and replaces the visible memory with the canonical result", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		let currentEntry = entry;
		client.memory.listCandidates = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { candidates: [] } }),
		);
		client.memory.search = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { entries: [currentEntry] } }),
		);
		client.memory.edit = vi.fn((_entryId, newText) => {
			currentEntry = { ...currentEntry, id: "entry-2", text: newText, normalizedText: newText };
			return Promise.resolve({ ok: true as const, data: null });
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: productUi.titlebar.backstage }));
		await user.click(screen.getByRole("tab", { name: productUi.backstage.memory }));
		const entries = await screen.findByRole("region", {
			name: productUi.memory.defaultEntriesTitle,
		});
		await user.click(within(entries).getByRole("button", { name: productUi.memory.edit }));
		const editor = within(entries).getByRole("textbox", { name: productUi.memory.editedContent });
		await user.clear(editor);
		await user.type(editor, "用户喜欢在清晨工作");
		await user.click(within(entries).getByRole("button", { name: productUi.memory.saveEdit }));

		await waitFor(() =>
			expect(client.memory.edit).toHaveBeenCalledWith("entry-1", "用户喜欢在清晨工作"),
		);
		expect(await within(entries).findByText("用户喜欢在清晨工作")).toBeInTheDocument();
		expect(within(entries).queryByText(entry.text)).not.toBeInTheDocument();
	});
});
