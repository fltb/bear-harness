import { render, screen, waitFor } from "@solidjs/testing-library";
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

		await user.click(await screen.findByRole("button", { name: "幕后" }));
		await user.click(screen.getByRole("tab", { name: "记忆" }));
		await screen.findAllByText(candidate.text);
		await user.click(screen.getByRole("button", { name: "记住" }));
		await user.click(screen.getByRole("button", { name: "置顶" }));
		const query = screen.getByRole("searchbox", { name: "搜索记忆" });
		await user.type(query, "夜里");
		await user.click(screen.getByRole("button", { name: "搜索" }));

		await waitFor(() => {
			expect(decideCandidate).toHaveBeenCalledWith("candidate-1", "approve", undefined, "self");
			expect(pin).toHaveBeenCalledWith("entry-1", true);
			expect(search).toHaveBeenCalledWith("夜里", "self");
		});
	});
});
