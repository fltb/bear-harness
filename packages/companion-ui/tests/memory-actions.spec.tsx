import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

const userEntry = {
	id: "entry-user",
	kind: "fact",
	scope: "self" as const,
	text: "用户喜欢在夜里工作",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	importance: 0.8,
};

const forgottenEntry = {
	id: "entry-forgotten",
	kind: "preference",
	scope: "self" as const,
	text: "用户偏好简短回答",
	createdAt: "2026-01-02T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
	importance: 0.6,
};

const invalidatedEntry = {
	id: "entry-invalidated",
	kind: "event",
	scope: "self" as const,
	text: "用户曾在夜里散步",
	createdAt: "2026-01-03T00:00:00.000Z",
	updatedAt: "2026-01-03T00:00:00.000Z",
	importance: 0.5,
};

const relationshipEntry = {
	id: "entry-relationship",
	kind: "fact",
	scope: "relationship" as const,
	text: "我们会一起散步",
	createdAt: "2026-01-04T00:00:00.000Z",
	updatedAt: "2026-01-04T00:00:00.000Z",
	importance: 0.7,
};

const entry = userEntry;

describe("memory controls", () => {
	it("loads empty panels from the scoped direct list and searches only non-empty queries", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		let currentEntries = [userEntry, forgottenEntry, invalidatedEntry, relationshipEntry];
		const list = vi.fn((request?: { scope?: "self" | "relationship" | "scene" }) =>
			Promise.resolve({
				ok: true as const,
				data: {
					entries: request?.scope
						? currentEntries.filter((item) => item.scope === request.scope)
						: currentEntries,
				},
			}),
		);
		const search = vi.fn((request: { query: string; scope?: "self" | "relationship" | "scene" }) =>
			Promise.resolve({
				ok: true as const,
				data: {
					entries: currentEntries.filter(
						(item) =>
							item.scope === request.scope &&
							(request.query === "" || item.text.includes(request.query)),
					),
				},
			}),
		);
		const edit = vi.fn((request: { entryId: string; newText: string }) => {
			currentEntries = currentEntries.map((item) =>
				item.id === request.entryId
					? { ...item, text: request.newText, updatedAt: "2026-01-05T00:00:00.000Z" }
					: item,
			);
			return Promise.resolve({ ok: true as const, data: null });
		});
		const forget = vi.fn((request: { entryId: string }) => {
			currentEntries = currentEntries.filter((item) => item.id !== request.entryId);
			return Promise.resolve({ ok: true as const, data: null });
		});
		client.memory.list = list;
		client.memory.search = search;
		client.memory.edit = edit;
		client.memory.forget = forget;
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: zhCN.sidebar.characterSettings }));
		const backstage = await screen.findByRole("dialog", { name: zhCN.backstage.title });
		await user.click(within(backstage).getByRole("tab", { name: zhCN.backstage.memory }));
		const region = await within(backstage).findByRole("region", {
			name: zhCN.memory.defaultEntriesTitle,
		});
		await waitFor(() => expect(list).toHaveBeenCalledWith({ scope: "self" }));
		expect(search).not.toHaveBeenCalledWith({ query: "", scope: "self" });
		expect(within(region).getByText(userEntry.text)).toBeVisible();

		const editedItem = within(region).getByText(userEntry.text).closest("li") as HTMLElement;
		await user.click(within(editedItem).getByRole("button", { name: zhCN.memory.edit }));
		const editor = within(editedItem).getByRole("textbox", { name: zhCN.memory.editedContent });
		await user.clear(editor);
		await user.type(editor, "用户喜欢在清晨工作");
		await user.click(within(editedItem).getByRole("button", { name: zhCN.memory.saveEdit }));
		await waitFor(() =>
			expect(edit).toHaveBeenCalledWith({
				entryId: "entry-user",
				newText: "用户喜欢在清晨工作",
			}),
		);

		const forgottenItem = within(region)
			.getByText(forgottenEntry.text)
			.closest("li") as HTMLElement;
		await user.click(within(forgottenItem).getByRole("button", { name: zhCN.memory.forget }));
		await waitFor(() => expect(forget).toHaveBeenCalledWith({ entryId: "entry-forgotten" }));

		await user.click(within(backstage).getByRole("tab", { name: zhCN.memory.scopes.relationship }));
		const query = within(backstage).getByRole("searchbox", { name: zhCN.memory.searchLabel });
		await user.type(query, "一起");
		await user.click(within(backstage).getByRole("button", { name: zhCN.memory.search }));
		await waitFor(() =>
			expect(search).toHaveBeenCalledWith({ query: "一起", scope: "relationship" }),
		);
		expect(within(region).getByText(relationshipEntry.text)).toBeVisible();
	});

	it("edits a direct entry and replaces the visible memory with the canonical result", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		let currentEntry = entry;
		client.memory.search = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { entries: [currentEntry] } }),
		);
		client.memory.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { entries: [currentEntry] } }),
		);
		client.memory.edit = vi.fn(({ newText }) => {
			currentEntry = { ...currentEntry, id: "entry-2", text: newText, normalizedText: newText };
			return Promise.resolve({ ok: true as const, data: null });
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: zhCN.sidebar.characterSettings }));
		const backstage = await screen.findByRole("dialog", { name: zhCN.backstage.title });
		await user.click(within(backstage).getByRole("tab", { name: zhCN.backstage.memory }));
		const entries = await screen.findByRole("region", {
			name: zhCN.memory.defaultEntriesTitle,
		});
		await user.click(within(entries).getByRole("button", { name: zhCN.memory.edit }));
		const editor = within(entries).getByRole("textbox", { name: zhCN.memory.editedContent });
		await user.clear(editor);
		await user.type(editor, "用户喜欢在清晨工作");
		await user.click(within(entries).getByRole("button", { name: zhCN.memory.saveEdit }));

		await waitFor(() =>
			expect(client.memory.edit).toHaveBeenCalledWith({
				entryId: "entry-user",
				newText: "用户喜欢在清晨工作",
			}),
		);
		const updatedEntries = await within(backstage).findByRole("region", {
			name: zhCN.memory.defaultEntriesTitle,
		});
		const updatedItem = within(updatedEntries)
			.getByText("用户喜欢在清晨工作")
			.closest("li") as HTMLElement;
		expect(updatedItem).toBeVisible();
		expect(within(updatedEntries).queryByText(entry.text)).not.toBeInTheDocument();
	});

	it("surfaces direct-memory mutation failures in the panel", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		client.memory.search = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { entries: [userEntry] } }),
		);
		client.memory.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { entries: [userEntry] } }),
		);
		client.memory.edit = vi.fn(() => Promise.reject(new Error("direct memory write failed")));
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: zhCN.sidebar.characterSettings }));
		const backstage = await screen.findByRole("dialog", { name: zhCN.backstage.title });
		await user.click(within(backstage).getByRole("tab", { name: zhCN.backstage.memory }));
		const region = await within(backstage).findByRole("region", {
			name: zhCN.memory.defaultEntriesTitle,
		});
		const item = within(region).getByText(userEntry.text).closest("li") as HTMLElement;
		await user.click(within(item).getByRole("button", { name: zhCN.memory.edit }));
		const editor = within(item).getByRole("textbox", { name: zhCN.memory.editedContent });
		await user.clear(editor);
		await user.type(editor, "这次修订会失败");
		await user.click(within(item).getByRole("button", { name: zhCN.memory.saveEdit }));

		await waitFor(() =>
			expect(within(region).getByRole("alert")).toHaveTextContent("direct memory write failed"),
		);
		expect(within(region).queryByRole("status")).not.toBeInTheDocument();
	});

	it("renders the empty state when a direct-memory scope has no results", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		client.memory.list = vi.fn(() => Promise.resolve({ ok: true as const, data: { entries: [] } }));
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: zhCN.sidebar.characterSettings }));
		const backstage = await screen.findByRole("dialog", { name: zhCN.backstage.title });
		await user.click(within(backstage).getByRole("tab", { name: zhCN.backstage.memory }));
		const region = await within(backstage).findByRole("region", {
			name: zhCN.memory.defaultEntriesTitle,
		});
		expect(await within(region).findByText(zhCN.memory.emptyEntries)).toBeVisible();
		expect(within(region).queryByRole("listitem")).not.toBeInTheDocument();
	});
});
