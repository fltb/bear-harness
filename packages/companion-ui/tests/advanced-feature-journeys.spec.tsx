import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanonStudio } from "../src/features/CanonStudio.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";

function renderWithStore(ui: () => unknown, store: Partial<CompanionStore>) {
	return render(() => (
		<DesktopProvider store={store as CompanionStore}>{ui() as never}</DesktopProvider>
	));
}

describe("advanced feature journeys", () => {
	it("adds canon source, searches original text, and creates a referenced module", async () => {
		const user = userEvent.setup();
		const addSource = vi.fn(() => Promise.resolve());
		const search = vi.fn(() =>
			Promise.resolve([
				{
					id: "chunk-1",
					sourceId: "source-1",
					sourceName: "第一卷",
					ordinal: 0,
					content: "原文片段",
				},
			]),
		);
		const upsertModule = vi.fn(() => Promise.resolve());
		renderWithStore(() => <CanonStudio />, {
			canon: {
				sources: () => [],
				modules: () => [],
				listSources: vi.fn(() => Promise.resolve()),
				listModules: vi.fn(() => Promise.resolve()),
				addSource,
				search,
				upsertModule,
			} as never,
		});

		await user.type(screen.getByRole("textbox", { name: zhCN.canonStudio.sourceName }), "第一卷");
		await user.type(screen.getByRole("textbox", { name: zhCN.canonStudio.sourceText }), "完整原文");
		await user.click(screen.getByRole("button", { name: zhCN.canonStudio.addSource }));
		expect(addSource).toHaveBeenCalledWith("第一卷", "完整原文");

		await user.type(screen.getByRole("textbox", { name: zhCN.canonStudio.search }), "关键事件");
		await user.click(screen.getByRole("button", { name: zhCN.canonStudio.search }));
		await user.click(await screen.findByRole("checkbox", { name: /原文片段/ }));
		await user.type(
			screen.getByRole("textbox", { name: zhCN.canonStudio.moduleTitle }),
			"入口回忆",
		);
		await user.type(
			screen.getByRole("textbox", { name: zhCN.canonStudio.moduleInstructions }),
			"从原剧情开始回忆",
		);
		await user.click(screen.getByRole("button", { name: zhCN.canonStudio.saveModule }));
		expect(upsertModule).toHaveBeenCalledWith({
			kind: "arc",
			title: "入口回忆",
			instructions: "从原剧情开始回忆",
			sourceChunkIds: ["chunk-1"],
		});
	});

	it("edits and removes named canon objects without relying on list position", async () => {
		const user = userEvent.setup();
		const removeSource = vi.fn(() => Promise.resolve());
		const deleteModule = vi.fn(() => Promise.resolve());
		const upsertModule = vi.fn(() => Promise.resolve());
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
				modules: () => [
					{
						id: "module-1",
						kind: "event",
						title: "旧事件",
						instructions: "旧说明",
						sourceChunkIds: ["chunk-1"],
						createdAt: "2026-08-16T00:00:00Z",
					},
				],
				listSources: vi.fn(() => Promise.resolve()),
				listModules: vi.fn(() => Promise.resolve()),
				removeSource,
				deleteModule,
				upsertModule,
			} as never,
		});

		await user.click(screen.getByRole("button", { name: `${zhCN.canonStudio.remove} 第一卷` }));
		expect(removeSource).toHaveBeenCalledWith("source-1");
		await user.click(screen.getByRole("button", { name: `${zhCN.canonStudio.editModule} 旧事件` }));
		const title = screen.getByRole("textbox", { name: zhCN.canonStudio.moduleTitle });
		await user.clear(title);
		await user.type(title, "新事件");
		await user.click(screen.getByRole("button", { name: zhCN.canonStudio.updateModule }));
		expect(upsertModule).toHaveBeenCalledWith({
			id: "module-1",
			kind: "event",
			title: "新事件",
			instructions: "旧说明",
			sourceChunkIds: ["chunk-1"],
		});
		await user.click(screen.getByRole("button", { name: `${zhCN.canonStudio.remove} 旧事件` }));
		expect(deleteModule).toHaveBeenCalledWith("module-1");
	});
});
