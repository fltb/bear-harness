import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import type { RunInfo } from "../src/stores/ipc.js";
import { WorkTimelineItem } from "../src/WorkPanel.js";

const run = (id: string, status: RunInfo["status"]): RunInfo => ({
	id,
	conversationId: "conversation-1",
	triggerEntryId: "message-1",
	executorProfile: "pi-default",
	title: `${status} task`,
	status,
});

function renderWork(overrides: Partial<CompanionStore> = {}) {
	const steer = vi.fn(() => Promise.resolve());
	const interrupt = vi.fn(() => Promise.resolve());
	const resume = vi.fn(() => Promise.resolve());
	const cancel = vi.fn(() => Promise.resolve());
	const respondPermission = vi.fn(() => Promise.resolve());
	const store = {
		activeConversationId: "conversation-1",
		errorMetadata: null,
		runs: [
			run("running", "running"),
			run("needs-user", "needs_user"),
			run("interrupted", "interrupted"),
			run("completed", "completed"),
			run("failed", "failed"),
			run("cancelled", "cancelled"),
			run("forced", "forced_termination"),
		],
		run: {
			steer,
			interrupt,
			resume,
			cancel,
			respondPermission,
			pendingPermissions: () => [
				{
					runId: "needs-user",
					requestId: "permission-1",
					prompt: "Allow the operation?",
					options: [
						{ optionId: "allow", kind: "allow_once", name: "Allow" },
						{ optionId: "deny", kind: "reject_once", name: "Deny" },
					],
				},
			],
		},
		...overrides,
	} as unknown as CompanionStore;
	render(() => (
		<DesktopProvider store={store}>
			<WorkTimelineItem messageId="message-1" />
		</DesktopProvider>
	));
	return { store, steer, interrupt, resume, cancel, respondPermission };
}

describe("work timeline controls", () => {
	it("renders every terminal state and drives steer, interrupt, resume and permissions", async () => {
		const user = userEvent.setup();
		const actions = renderWork();

		expect(screen.getByText(zhCN.work.timeline.completed)).toBeVisible();
		expect(screen.getAllByText(zhCN.work.timeline.failed)).toHaveLength(3);
		expect(screen.getByText(zhCN.work.timeline.needsYou)).toBeVisible();

		const steerInputs = screen.getAllByRole("textbox", { name: zhCN.work.steerInputLabel });
		await user.type(steerInputs[0]!, "continue carefully");
		await user.click(screen.getAllByRole("button", { name: zhCN.work.timeline.steer })[0]!);
		await waitFor(() =>
			expect(actions.steer).toHaveBeenCalledWith("running", "continue carefully"),
		);
		expect(steerInputs[0]).toHaveValue("");

		await user.click(screen.getAllByRole("button", { name: zhCN.work.timeline.interrupt })[0]!);
		expect(actions.interrupt).toHaveBeenCalledWith("running");
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.resume }));
		expect(actions.resume).toHaveBeenCalledWith("interrupted");

		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.permissionAllow }));
		expect(actions.respondPermission).toHaveBeenCalledWith("needs-user", "permission-1", "allow");
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.permissionDeny }));
		expect(actions.respondPermission).toHaveBeenCalledWith("needs-user", "permission-1", "deny");
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.stopRun }));
		expect(actions.cancel).toHaveBeenCalledWith("needs-user");
	});

	it("shows action failures and omits runs from another conversation", async () => {
		const user = userEvent.setup();
		const failure = new Error("permission rejected locally");
		const cancel = vi.fn(() => Promise.reject(failure));
		renderWork({
			runs: [
				run("needs-user", "needs_user"),
				{ ...run("other", "running"), conversationId: "other" },
			],
			run: {
				cancel,
				respondPermission: vi.fn(() => Promise.resolve()),
				steer: vi.fn(() => Promise.resolve()),
				interrupt: vi.fn(() => Promise.resolve()),
				resume: vi.fn(() => Promise.resolve()),
				pendingPermissions: () => [
					{
						runId: "needs-user",
						requestId: "permission-1",
						prompt: "Allow the operation?",
						options: [],
					},
				],
			} as CompanionStore["run"],
		});

		expect(screen.queryByText("running task")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.stopRun }));
		expect(await screen.findByRole("alert")).toHaveTextContent(failure.message);
	});
});
