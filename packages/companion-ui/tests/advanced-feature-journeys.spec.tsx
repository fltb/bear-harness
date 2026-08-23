import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanonStudio } from "../src/features/CanonStudio.js";
import { ResultSpaceProvider } from "../src/features/ResultSpace.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { WorkTimelineItem } from "../src/WorkPanel.js";

function renderWithStore(ui: () => unknown, store: Partial<CompanionStore>) {
	return render(() => (
		<DesktopProvider store={store as CompanionStore}>
			<ResultSpaceProvider>{ui() as never}</ResultSpaceProvider>
		</DesktopProvider>
	));
}

describe("advanced feature journeys", () => {
	it("launches already-approved network work without approving it twice", async () => {
		const user = userEvent.setup();
		const approve = vi.fn(() => Promise.resolve());
		const launch = vi.fn(() => Promise.resolve({} as never));
		renderWithStore(() => <WorkTimelineItem messageId="message-1" />, {
			character: undefined,
			activeConversationId: "conversation-1",
			runs: [
				{
					id: "run-small",
					commissionId: "commission-1",
					executorProfile: "pi",
					status: "completed",
				},
				{
					id: "run-large",
					commissionId: "commission-1",
					executorProfile: "pi",
					status: "completed",
				},
			],
			commission: {
				commissions: () => [
					{
						id: "commission-1",
						triggerEntryId: "message-1",
						status: "approved",
						createdAt: "2026-08-16T00:00:00Z",
						draft: {
							title: "Online work",
							description: "Use a remote source",
							reads: [],
							writes: [],
							networkAllowed: true,
							toolNames: [],
							hash: "hash",
						},
					},
				],
				approve,
				launch,
			} as never,
			run: { pendingPermissions: () => [] } as never,
			artifact: {
				artifacts: () => [
					{
						id: "small",
						logicalName: "small.txt",
						mime: "text/plain",
						bytes: 12,
						sha256: "small",
						status: "saved",
						producerRunId: "run-small",
						createdAt: "2026-08-16T00:00:00Z",
					},
					{
						id: "large",
						logicalName: "large.bin",
						mime: "application/octet-stream",
						bytes: 2 * 1024 * 1024,
						sha256: "large",
						status: "created",
						producerRunId: "run-large",
						createdAt: "2026-08-16T00:00:00Z",
					},
				],
				download: vi.fn(() => Promise.resolve()),
			} as never,
		});
		expect(screen.getByText(zhCN.work.networkYes)).toBeVisible();
		expect(screen.getAllByText(/12 B/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/2\.0 MB/).length).toBeGreaterThan(0);
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.start }));
		expect(approve).not.toHaveBeenCalled();
		expect(launch).toHaveBeenCalledWith("commission-1", "pi-product-managed");
	});

	it("approves scoped work, answers permission, and downloads its artifact", async () => {
		const user = userEvent.setup();
		const approve = vi.fn(() => Promise.resolve());
		const launch = vi.fn(() => Promise.resolve({} as never));
		const respondPermission = vi.fn(() => Promise.resolve({} as never));
		const cancel = vi.fn(() => Promise.resolve({} as never));
		const download = vi.fn(() => Promise.resolve());
		renderWithStore(() => <WorkTimelineItem messageId="message-1" />, {
			character: undefined,
			activeConversationId: "conversation-1",
			runs: [
				{ id: "run-1", commissionId: "commission-1", executorProfile: "pi", status: "needs_user" },
			],
			commission: {
				commissions: () => [
					{
						id: "commission-1",
						conversationId: "conversation-1",
						triggerEntryId: "message-1",
						status: "draft",
						createdAt: "2026-08-16T00:00:00Z",
						draft: {
							title: "整理报告",
							description: "读取资料并写出报告",
							reads: ["notes.txt"],
							writes: ["report.md"],
							networkAllowed: false,
							toolNames: ["read", "write"],
							hash: "draft-hash",
						},
					},
				],
				approve,
				launch,
			} as never,
			run: {
				pendingPermissions: () => [
					{
						runId: "run-1",
						requestId: "permission-1",
						prompt: "允许写入报告？",
						options: [
							{ optionId: "allow", kind: "allow_once", name: "Allow" },
							{ optionId: "deny", kind: "reject_once", name: "Deny" },
						],
					},
				],
				respondPermission,
				cancel,
			} as never,
			artifact: {
				artifacts: () => [
					{
						id: "artifact-1",
						logicalName: "report.md",
						mime: "text/markdown",
						bytes: 2048,
						sha256: "hash",
						status: "verified",
						producerRunId: "run-1",
						createdAt: "2026-08-16T00:00:00Z",
					},
				],
				download,
			} as never,
		});

		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.start }));
		expect(approve).toHaveBeenCalledWith("commission-1", "draft-hash");
		expect(launch).toHaveBeenCalledWith("commission-1", "pi-product-managed");
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.permissionAllow }));
		expect(respondPermission).toHaveBeenCalledWith("run-1", "permission-1", "allow");
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.stopRun }));
		expect(cancel).toHaveBeenCalledWith("run-1");
		// The run's evidence row keeps the per-artifact download, reachable
		// through the collapsed tool-trace detail of the action line.
		const trace = screen.getByText(zhCN.work.timeline.revealDetails).closest("details");
		expect(trace).not.toBeNull();
		(trace as HTMLDetailsElement).open = true;
		await user.click(screen.getByRole("button", { name: zhCN.work.download }));
		expect(download).toHaveBeenCalledWith("artifact-1");
	});

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
