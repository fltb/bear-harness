import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationPanel } from "../src/ConversationPanel.js";
import {
	RESULT_LOCATE_EVENT,
	type ResultSpaceApi,
	ResultSpaceProvider,
	useResultSpace,
} from "../src/features/ResultSpace.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { WorkTimelineItem } from "../src/WorkPanel.js";

/**
 * Work action lines: message-scoped rendering inside the conversation
 * timeline. WorkTimelineItem only ever renders commissions whose
 * `triggerMessageId` matches its own message id.
 */

function renderWithStore(ui: () => unknown, store: Partial<CompanionStore>) {
	return render(() => (
		<DesktopProvider store={store as CompanionStore}>
			<ResultSpaceProvider>{ui() as never}</ResultSpaceProvider>
		</DesktopProvider>
	));
}

function commissionOf(
	id: string,
	triggerMessageId: string,
	title: string,
	status: "draft" | "approved" = "approved",
) {
	return {
		id,
		conversationId: "conversation-1",
		triggerMessageId,
		status,
		createdAt: "2026-08-16T00:00:00Z",
		draft: {
			title,
			description: `描述：${title}`,
			reads: [],
			writes: [],
			networkAllowed: false,
			toolNames: [],
			hash: "hash",
		},
	};
}

function runOf(id: string, commissionId: string, status: string) {
	return { id, commissionId, executorProfile: "pi", status };
}

function artifactOf(id: string, runId: string, logicalName: string) {
	return {
		id,
		logicalName,
		mime: "text/markdown",
		bytes: 128,
		sha256: "sha",
		status: "verified",
		producerRunId: runId,
		createdAt: "2026-08-16T00:00:00Z",
	};
}

function workStore(overrides: Partial<CompanionStore> = {}) {
	return {
		activeConversationId: "conversation-1",
		runs: [],
		commission: {
			commissions: () => [],
			approve: vi.fn(() => Promise.resolve()),
			reject: vi.fn(() => Promise.resolve()),
			launch: vi.fn(() => Promise.resolve({} as never)),
		} as never,
		run: {
			pendingPermissions: () => [],
			steer: vi.fn(() => Promise.resolve()),
			interrupt: vi.fn(() => Promise.resolve({} as never)),
			resume: vi.fn(() => Promise.resolve({} as never)),
			cancel: vi.fn(() => Promise.resolve({} as never)),
			respondPermission: vi.fn(() => Promise.resolve({} as never)),
		} as never,
		artifact: {
			artifacts: () => [],
			download: vi.fn(() => Promise.resolve()),
		} as never,
		...overrides,
	} as Partial<CompanionStore>;
}

function renderTimeline(store: Partial<CompanionStore>, messageIds: string | string[]) {
	const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
	return renderWithStore(
		() => (
			<>
				{ids.map((id) => (
					<WorkTimelineItem messageId={id} character={undefined} />
				))}
				<ResultSpaceProbe />
			</>
		),
		store,
	);
}

/** Exposes the ResultSpace API for spying without depending on its internals. */
function ResultSpaceProbe() {
	const api = useResultSpace();
	const testWindow = window as typeof window & { __resultSpaceApi?: ResultSpaceApi };
	testWindow.__resultSpaceApi = api;
	return null;
}

const ROLE_LABELS = {
	proposal: "极昼要交给下级程序的事",
	running: "极昼正在处理",
	needs_user: "极昼需要你决定",
	interrupted: "已暂停",
	completed: "已完成",
	failed: "未完成",
	steer_placeholder: "给下级程序的指示…",
	interrupt: "暂停",
	resume: "继续",
	approve: "交给它们",
	reject: "这次算了",
	artifact_open: "查看成果",
	artifact_reveal: "查看依据",
};

function roleCharacter() {
	return {
		name: "极昼",
		character: { work_presentation: { labels: ROLE_LABELS } },
	} as never;
}

describe("work action lines", () => {
	it("attaches each commission to its own triggering message", () => {
		const store = workStore({
			runs: [
				runOf("run-a", "commission-a", "completed"),
				runOf("run-b", "commission-b", "completed"),
			],
			commission: {
				commissions: () => [
					commissionOf("commission-a", "message-a", "整理会议记录"),
					commissionOf("commission-b", "message-b", "生成周报"),
				],
				approve: vi.fn(() => Promise.resolve()),
				reject: vi.fn(() => Promise.resolve()),
				launch: vi.fn(() => Promise.resolve({} as never)),
			} as never,
			artifact: {
				artifacts: () => [
					artifactOf("artifact-a", "run-a", "meeting-notes.md"),
					artifactOf("artifact-b", "run-b", "weekly-report.md"),
				],
				download: vi.fn(() => Promise.resolve()),
			} as never,
		});
		renderTimeline(store, ["message-a", "message-b", "message-unrelated"]);

		// Both action lines render, each carrying only its own commission's run.
		// (Artifact names appear in the completion card and the collapsed
		// tool-trace detail, so the lines are located via the first match.)
		const lineA = screen.getAllByText("meeting-notes.md")[0].closest(".work-action-line");
		const lineB = screen.getAllByText("weekly-report.md")[0].closest(".work-action-line");
		expect(lineA).not.toBeNull();
		expect(lineB).not.toBeNull();
		expect(lineA).not.toBe(lineB);

		// Each action line exposes only artifacts produced by its own run.
		const lineAQueries = within(lineA as HTMLElement);
		expect(lineAQueries.getAllByText("meeting-notes.md").length).toBeGreaterThan(0);
		expect(lineAQueries.queryByText("weekly-report.md")).toBeNull();

		const lineBQueries = within(lineB as HTMLElement);
		expect(lineBQueries.getAllByText("weekly-report.md").length).toBeGreaterThan(0);
		expect(lineBQueries.queryByText("meeting-notes.md")).toBeNull();

		// An unrelated message renders no controls at all.
		expect(screen.getAllByRole("button", { name: zhCN.work.timeline.viewArtifacts })).toHaveLength(
			2,
		);
	});

	it("uses configured role wording for proposal titles and buttons", () => {
		const store = workStore({
			commission: {
				commissions: () => [commissionOf("commission-1", "message-1", "整理资料", "draft")],
				approve: vi.fn(() => Promise.resolve()),
				reject: vi.fn(() => Promise.resolve()),
				launch: vi.fn(() => Promise.resolve({} as never)),
			} as never,
		});
		render(() => (
			<DesktopProvider store={store as CompanionStore}>
				<ResultSpaceProvider>
					<WorkTimelineItem messageId="message-1" character={roleCharacter()} />
				</ResultSpaceProvider>
			</DesktopProvider>
		));

		expect(screen.getByText(ROLE_LABELS.proposal)).toBeVisible();
		expect(screen.getByRole("button", { name: ROLE_LABELS.approve })).toBeVisible();
		expect(screen.getByRole("button", { name: ROLE_LABELS.reject })).toBeVisible();
	});

	it("falls back to Chinese i18n wording when the character has no labels", () => {
		const store = workStore({
			commission: {
				commissions: () => [commissionOf("commission-1", "message-1", "整理资料", "draft")],
				approve: vi.fn(() => Promise.resolve()),
				reject: vi.fn(() => Promise.resolve()),
				launch: vi.fn(() => Promise.resolve({} as never)),
			} as never,
		});
		renderTimeline(store, "message-1");

		expect(screen.getByText(zhCN.work.timeline.proposal)).toBeVisible();
		expect(screen.getByRole("button", { name: zhCN.work.timeline.start })).toBeVisible();
		expect(screen.getByRole("button", { name: zhCN.work.timeline.cancel })).toBeVisible();
	});

	it("steers and interrupts a running run", async () => {
		const user = userEvent.setup();
		const steer = vi.fn(() => Promise.resolve());
		const interrupt = vi.fn(() => Promise.resolve({} as never));
		const store = workStore({
			runs: [runOf("run-1", "commission-1", "running")],
			commission: {
				commissions: () => [commissionOf("commission-1", "message-1", "在线整理资料")],
				approve: vi.fn(() => Promise.resolve()),
				reject: vi.fn(() => Promise.resolve()),
				launch: vi.fn(() => Promise.resolve({} as never)),
			} as never,
			run: {
				pendingPermissions: () => [],
				steer,
				interrupt,
				resume: vi.fn(() => Promise.resolve({} as never)),
			} as never,
		});
		renderTimeline(store, "message-1");

		expect(screen.getByText(zhCN.work.timeline.runStatuses.running)).toBeVisible();

		const input = screen.getByRole("textbox", { name: zhCN.work.steerInputLabel });
		const steerButton = screen.getByRole("button", { name: zhCN.work.timeline.steer });
		expect(steerButton).toBeDisabled();
		await user.type(input, "慢一点，先检查权限");
		expect(steerButton).toBeEnabled();
		await user.keyboard("{Enter}");
		await waitFor(() => expect(steer).toHaveBeenCalledWith("run-1", "慢一点，先检查权限"));

		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.interrupt }));
		await waitFor(() => expect(interrupt).toHaveBeenCalledWith("run-1"));
		expect(
			screen.queryByRole("button", { name: zhCN.work.timeline.resume }),
		).not.toBeInTheDocument();
	});

	it("resumes an interrupted run without offering steer or interrupt", async () => {
		const user = userEvent.setup();
		const resume = vi.fn(() => Promise.resolve({} as never));
		const store = workStore({
			runs: [runOf("run-1", "commission-1", "interrupted")],
			commission: {
				commissions: () => [commissionOf("commission-1", "message-1", "在线整理资料")],
				approve: vi.fn(() => Promise.resolve()),
				reject: vi.fn(() => Promise.resolve()),
				launch: vi.fn(() => Promise.resolve({} as never)),
			} as never,
			run: {
				pendingPermissions: () => [],
				steer: vi.fn(() => Promise.resolve()),
				interrupt: vi.fn(() => Promise.resolve({} as never)),
				resume,
			} as never,
		});
		renderTimeline(store, "message-1");

		expect(screen.getByText(zhCN.work.timeline.runStatuses.interrupted)).toBeVisible();
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.resume }));
		await waitFor(() => expect(resume).toHaveBeenCalledWith("run-1"));
		expect(
			screen.queryByRole("button", { name: zhCN.work.timeline.interrupt }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("textbox", { name: zhCN.work.steerInputLabel }),
		).not.toBeInTheDocument();
	});

	it("steers a needs_user run and keeps the permission flow", async () => {
		const user = userEvent.setup();
		const steer = vi.fn(() => Promise.resolve());
		const respondPermission = vi.fn(() => Promise.resolve({} as never));
		const cancel = vi.fn(() => Promise.resolve({} as never));
		const store = workStore({
			runs: [runOf("run-1", "commission-1", "needs_user")],
			commission: {
				commissions: () => [commissionOf("commission-1", "message-1", "在线整理资料")],
				approve: vi.fn(() => Promise.resolve()),
				reject: vi.fn(() => Promise.resolve()),
				launch: vi.fn(() => Promise.resolve({} as never)),
			} as never,
			run: {
				pendingPermissions: () => [
					{
						runId: "run-1",
						requestId: "permission-1",
						prompt: "允许读取文件？",
						options: [
							{ optionId: "allow", kind: "allow", name: "允许" },
							{ optionId: "deny", kind: "reject", name: "不允许" },
						],
					},
				],
				steer,
				interrupt: vi.fn(() => Promise.resolve({} as never)),
				resume: vi.fn(() => Promise.resolve({} as never)),
				cancel,
				respondPermission,
			} as never,
		});
		renderTimeline(store, "message-1");

		const input = screen.getByRole("textbox", { name: zhCN.work.steerInputLabel });
		await user.type(input, "按你的判断继续");
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.steer }));
		await waitFor(() => expect(steer).toHaveBeenCalledWith("run-1", "按你的判断继续"));

		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.permissionAllow }));
		expect(respondPermission).toHaveBeenCalledWith("run-1", "permission-1", "allow");
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.stopRun }));
		expect(cancel).toHaveBeenCalledWith("run-1");
	});

	it("opens the exact result selection with the invoking button as focus return", async () => {
		const user = userEvent.setup();
		const store = workStore({
			runs: [runOf("run-1", "commission-1", "completed")],
			commission: {
				commissions: () => [commissionOf("commission-1", "message-1", "整理报告")],
				approve: vi.fn(() => Promise.resolve()),
				reject: vi.fn(() => Promise.resolve()),
				launch: vi.fn(() => Promise.resolve({} as never)),
			} as never,
			artifact: {
				artifacts: () => [artifactOf("artifact-1", "run-1", "report.md")],
				download: vi.fn(() => Promise.resolve()),
			} as never,
		});
		renderTimeline(store, "message-1");
		const testWindow = window as typeof window & { __resultSpaceApi?: ResultSpaceApi };
		const api = testWindow.__resultSpaceApi;
		if (!api) {
			throw new Error("ResultSpace API was not initialized");
		}
		const open = vi.spyOn(api, "open");

		const openButton = screen.getByRole("button", { name: zhCN.work.timeline.viewArtifacts });
		await user.click(openButton);

		expect(open).toHaveBeenCalledWith(
			{
				conversationId: "conversation-1",
				triggerMessageId: "message-1",
				commissionId: "commission-1",
				runId: "run-1",
				artifactId: "artifact-1",
			},
			openButton,
		);
		expect(api.selection()).toEqual({
			conversationId: "conversation-1",
			triggerMessageId: "message-1",
			commissionId: "commission-1",
			runId: "run-1",
			artifactId: "artifact-1",
		});
	});

	it("renders the action line only under its triggering user message", async () => {
		const store = workStore({
			activeMessages: [
				{
					id: "message-1",
					role: "user",
					versions: [
						{
							id: "version-1",
							role: "user",
							content: "把三份会议记录整理成周报",
							editedByUser: false,
							createdAt: "2026-08-16T00:00:00Z",
						},
					],
					createdAt: "2026-08-16T00:00:00Z",
				},
				{
					id: "message-2",
					role: "assistant",
					versions: [
						{
							id: "version-2",
							role: "assistant",
							content: "好的，我来整理。",
							editedByUser: false,
							createdAt: "2026-08-16T00:00:01Z",
						},
					],
					createdAt: "2026-08-16T00:00:01Z",
				},
			],
			conversations: [],
			error: null,
			pendingUserText: undefined,
			assistantStreaming: false,
			streamingAssistantText: "",
			toolActivities: [],
			commission: {
				commissions: () => [commissionOf("commission-1", "message-1", "整理会议记录", "draft")],
				approve: vi.fn(() => Promise.resolve()),
				reject: vi.fn(() => Promise.resolve()),
				launch: vi.fn(() => Promise.resolve({} as never)),
			} as never,
		});
		render(() => (
			<DesktopProvider store={store as CompanionStore}>
				<ResultSpaceProvider>
					<ConversationPanel character={undefined} />
				</ResultSpaceProvider>
			</DesktopProvider>
		));

		// The work proposal appears below the message that triggered it.
		expect(screen.getByText(zhCN.work.timeline.proposal)).toBeVisible();
		const line = screen.getByText("整理会议记录").closest(".work-action-line");
		expect(line?.getAttribute("data-message-id")).toBe("message-1");

		// "定位到对话" scrolls and focuses the source message and its line.
		const messageArticle = screen.getByText("把三份会议记录整理成周报").closest(".msg");
		expect(messageArticle).not.toBeNull();
		window.dispatchEvent(
			new CustomEvent(RESULT_LOCATE_EVENT, {
				detail: { conversationId: "conversation-1", messageId: "message-1" },
			}),
		);
		await waitFor(() => expect(messageArticle as HTMLElement).toHaveFocus());

		// Locate for a foreign conversation is ignored.
		window.dispatchEvent(
			new CustomEvent(RESULT_LOCATE_EVENT, {
				detail: { conversationId: "conversation-2", messageId: "message-1" },
			}),
		);
		expect(messageArticle as HTMLElement).toHaveFocus();
	});
});
