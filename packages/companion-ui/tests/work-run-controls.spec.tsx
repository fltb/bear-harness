import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { WorkPanel } from "../src/WorkPanel.js";

function renderWithStore(ui: () => unknown, store: Partial<CompanionStore>) {
	return render(() => (
		<DesktopProvider store={store as CompanionStore}>{ui() as never}</DesktopProvider>
	));
}

const COMMISSION = {
	id: "commission-1",
	status: "approved" as const,
	createdAt: "2026-08-16T00:00:00Z",
	draft: {
		title: "在线整理资料",
		description: "Use a remote source",
		reads: [],
		writes: [],
		networkAllowed: true,
		toolNames: [],
		hash: "hash",
	},
};

function runStore(overrides: {
	status: "running" | "interrupted" | "needs_user";
	steer?: ReturnType<typeof vi.fn>;
	interrupt?: ReturnType<typeof vi.fn>;
	resume?: ReturnType<typeof vi.fn>;
}) {
	const steer = overrides.steer ?? vi.fn(() => Promise.resolve());
	const interrupt = overrides.interrupt ?? vi.fn(() => Promise.resolve({} as never));
	const resume = overrides.resume ?? vi.fn(() => Promise.resolve({} as never));
	const store = {
		activeConversationId: "conversation-1",
		runs: [
			{
				id: "run-1",
				commissionId: "commission-1",
				executorProfile: "pi",
				status: overrides.status,
			},
		],
		commission: {
			commissions: () => [COMMISSION],
			approve: vi.fn(() => Promise.resolve()),
			launch: vi.fn(() => Promise.resolve({} as never)),
		} as never,
		run: { pendingPermissions: () => [], steer, interrupt, resume } as never,
		artifact: { artifacts: () => [], download: vi.fn(() => Promise.resolve()) } as never,
	};
	return { store, steer, interrupt, resume };
}

describe("work panel run controls", () => {
	it("steers and interrupts a running run", async () => {
		const user = userEvent.setup();
		const { store, steer, interrupt } = runStore({ status: "running" });
		renderWithStore(() => <WorkPanel />, store);

		expect(screen.getByRole("region", { name: zhCN.work.title })).toBeVisible();
		expect(screen.getByText(zhCN.threadHead.runStatuses.running)).toBeVisible();

		const input = screen.getByRole("textbox", { name: zhCN.work.steerInputLabel });
		await user.type(input, "慢一点，先检查权限");
		await user.click(screen.getByRole("button", { name: zhCN.work.steer }));
		await waitFor(() => expect(steer).toHaveBeenCalledWith("run-1", "慢一点，先检查权限"));

		await user.click(screen.getByRole("button", { name: zhCN.work.interrupt }));
		await waitFor(() => expect(interrupt).toHaveBeenCalledWith("run-1"));
		expect(screen.queryByRole("button", { name: zhCN.work.resume })).not.toBeInTheDocument();
	});

	it("resumes an interrupted run without offering steer or interrupt", async () => {
		const user = userEvent.setup();
		const { store, resume } = runStore({ status: "interrupted" });
		renderWithStore(() => <WorkPanel />, store);

		expect(screen.getByText(zhCN.threadHead.runStatuses.interrupted)).toBeVisible();
		await user.click(screen.getByRole("button", { name: zhCN.work.resume }));
		await waitFor(() => expect(resume).toHaveBeenCalledWith("run-1"));
		expect(screen.queryByRole("button", { name: zhCN.work.interrupt })).not.toBeInTheDocument();
		expect(
			screen.queryByRole("textbox", { name: zhCN.work.steerInputLabel }),
		).not.toBeInTheDocument();
	});

	it("steers a needs_user run and keeps the permission flow", async () => {
		const user = userEvent.setup();
		const respondPermission = vi.fn(() => Promise.resolve({} as never));
		const { store, steer } = runStore({ status: "needs_user" });
		store.run = {
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
			respondPermission,
		} as never;
		renderWithStore(() => <WorkPanel />, store);

		const input = screen.getByRole("textbox", { name: zhCN.work.steerInputLabel });
		await user.type(input, "按你的判断继续");
		await user.click(screen.getByRole("button", { name: zhCN.work.steer }));
		await waitFor(() => expect(steer).toHaveBeenCalledWith("run-1", "按你的判断继续"));
		await user.click(screen.getByRole("button", { name: zhCN.work.allow }));
		expect(respondPermission).toHaveBeenCalledWith("run-1", "permission-1", "allow");
	});
});
