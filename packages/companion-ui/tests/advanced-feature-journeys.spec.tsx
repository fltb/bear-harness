import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanonStudio } from "../src/features/CanonStudio.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";

function renderWithStore(ui: () => unknown, store: Partial<CompanionStore>) {
	store.characters = {
		observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
	} as never;
	return render(() => (
		<DesktopProvider store={store as CompanionStore}>{ui() as never}</DesktopProvider>
	));
}

describe("advanced feature journeys", () => {
	it("adds canon source and searches original text", async () => {
		const user = userEvent.setup();
		const addSource = vi.fn(() => Promise.resolve());
		const chunks = [
			{
				id: "chunk-1",
				sourceId: "source-1",
				sourceName: "第一卷",
				ordinal: 0,
				content: "原文片段",
			},
		];
		const search = vi.fn(() => Promise.resolve(chunks));
		renderWithStore(() => <CanonStudio />, {
			canon: {
				sources: () => [],
				listSources: vi.fn(() => Promise.resolve()),
				addSource,
				search,
				searchResults: () => chunks,
			} as never,
		});

		await user.type(screen.getByRole("textbox", { name: zhCN.canonStudio.sourceName }), "第一卷");
		await user.type(screen.getByRole("textbox", { name: zhCN.canonStudio.sourceText }), "完整原文");
		await user.click(screen.getByRole("button", { name: zhCN.canonStudio.addSource }));
		expect(addSource).toHaveBeenCalledWith("第一卷", "完整原文");

		await user.type(screen.getByRole("textbox", { name: zhCN.canonStudio.search }), "关键事件");
		await user.click(screen.getByRole("button", { name: zhCN.canonStudio.search }));
		expect(search).toHaveBeenCalledWith("关键事件");
		expect(screen.getByText("原文片段")).toBeVisible();
	});

	it("removes a named user source without relying on list position", async () => {
		const user = userEvent.setup();
		const removeSource = vi.fn(() => Promise.resolve());
		vi.spyOn(window, "confirm").mockReturnValue(true);
		renderWithStore(() => <CanonStudio />, {
			canon: {
				sources: () => [
					{
						id: "source-1",
						logicalName: "第一卷",
						mime: "text/plain",
						sha256: "hash",
						chunkCount: 2,
						createdAt: "2026-08-16T00:00:00Z",
					},
				],
				listSources: vi.fn(() => Promise.resolve()),
				removeSource,
			} as never,
		});

		await user.click(screen.getByRole("button", { name: `${zhCN.canonStudio.remove} 第一卷` }));
		expect(removeSource).toHaveBeenCalledWith("source-1");
	});
});
