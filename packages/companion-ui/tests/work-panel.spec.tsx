import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import type { RunInfo } from "../src/stores/ipc.js";
import { ArtifactPreview, PermissionLayer, WorkTimelineItem } from "../src/WorkPanel.js";

const timestamp = "2026-08-31T00:00:00.000Z";
const artifact = (
	id: string,
	name: string,
	mime: string,
	bytes: number,
	status: RunInfo["artifacts"][number]["status"] = "verified",
): RunInfo["artifacts"][number] => ({
	id,
	name,
	mime,
	bytes,
	sha256: "a".repeat(64),
	status,
	createdAt: timestamp,
});

const run = (id: string, status: RunInfo["status"]): RunInfo => ({
	id,
	conversationId: "conversation-1",
	triggerEntryId: "message-1",
	executorProfile: "pi-default",
	title: `${status} task`,
	status,
	artifacts: [],
	evidence: [],
});

function renderWork(overrides: Partial<CompanionStore> = {}, showPermission = false) {
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
						{ optionId: "allow_always", kind: "allow_always", name: "Allow for session" },
						{
							optionId: "accept_execpolicy_amendment",
							kind: "allow_always",
							name: "Allow command pattern",
						},
						{ optionId: "deny", kind: "reject_once", name: "Deny" },
					],
				},
			],
		},
		...overrides,
	} as unknown as CompanionStore;
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const view = render(() => (
		<QueryClientProvider client={queryClient}>
			<DesktopProvider store={store}>
				<WorkTimelineItem messageId="message-1" />
				<ArtifactPreview />
				{showPermission ? <PermissionLayer /> : null}
			</DesktopProvider>
		</QueryClientProvider>
	));
	return { store, steer, interrupt, resume, cancel, respondPermission, unmount: view.unmount };
}

describe("work timeline controls", () => {
	it("renders every terminal state and drives steer, interrupt, resume and permissions", async () => {
		const user = userEvent.setup();
		const actions = renderWork();
		expect(screen.getByText(zhCN.work.timeline.completed)).toBeVisible();
		expect(screen.getAllByText(zhCN.work.timeline.failed)).toHaveLength(3);

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
	});

	it("keeps permission decisions in a blocking system-action card", async () => {
		const user = userEvent.setup();
		const actions = renderWork({}, true);
		expect(screen.getByRole("dialog", { name: zhCN.work.timeline.needsYou })).toBeVisible();
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.permissionAllow }));
		expect(actions.respondPermission).toHaveBeenCalledWith("needs-user", "permission-1", "allow");
		expect(
			screen.getByRole("button", { name: zhCN.work.timeline.permissionAllowSession }),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: zhCN.work.timeline.permissionAllowCommand }),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.permissionDeny }));
		expect(actions.respondPermission).toHaveBeenCalledWith("needs-user", "permission-1", "deny");
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.stopRun }));
		expect(actions.cancel).toHaveBeenCalledWith("needs-user");
	});

	it("shows action failures and omits runs from another conversation", async () => {
		const user = userEvent.setup();
		const failure = new Error("permission rejected locally");
		const cancel = vi.fn(() => Promise.reject(failure));
		renderWork(
			{
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
			},
			true,
		);

		expect(screen.queryByText("running task")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.stopRun }));
		expect(await screen.findByRole("alert")).toHaveTextContent(failure.message);
	});

	it("reads a selected text artifact in bounded chunks and drives every artifact action", async () => {
		const user = userEvent.setup();
		const read = vi.fn(async ({ conversationId, runId, artifactId, offset, length }) => {
			expect({ conversationId, runId, artifactId, length }).toEqual({
				conversationId: "conversation-1",
				runId: "completed",
				artifactId: "report",
				length: 1024 * 1024,
			});
			return offset === 0
				? {
						artifact: artifact("report", "report.md", "text/markdown", 11),
						offset: 0,
						nextOffset: 5,
						eof: false,
						base64: btoa("hello"),
					}
				: {
						artifact: artifact("report", "report.md", "text/markdown", 11),
						offset: 5,
						nextOffset: 11,
						eof: true,
						base64: btoa(" world"),
					};
		});
		const open = vi.fn(async () => ({ outcome: "completed" as const }));
		const reveal = vi.fn(async () => ({ outcome: "unsupported" as const }));
		const saveAs = vi.fn(async () => ({ outcome: "cancelled" as const }));
		renderWork({
			runs: [
				{
					...run("completed", "completed"),
					summary: "The report was generated from the requested source.",
					evidence: [
						{
							kind: "acp.tool_call",
							summary: "kind: read · status: completed",
							createdAt: timestamp,
						},
					],
					artifacts: [
						artifact("report", "report.md", "text/markdown", 640),
						artifact("archive", "archive.bin", "application/octet-stream", 3),
						artifact("large", "large.txt", "text/plain", 64 * 1024 * 1024 + 1),
					],
				},
			],
			artifact: { read, open, reveal, saveAs },
		});

		expect(screen.queryByRole("dialog", { name: "report.md" })).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", {
				name: `${zhCN.work.timeline.viewArtifacts}: report.md`,
			}),
		);
		const preview = screen.getByRole("dialog", { name: "report.md" });
		expect(preview).toHaveAttribute("data-artifact-preview", "report");
		expect(await within(preview).findByText("hello world")).toBeVisible();
		expect(read.mock.calls.map(([request]) => request.offset)).toEqual([0, 5]);
		expect(within(preview).getByText("text/markdown")).toBeVisible();
		expect(within(preview).getByText(zhCN.work.result.provenance)).toBeVisible();
		expect(within(preview).getByText(zhCN.work.artifactStatuses.verified)).toBeVisible();
		expect(
			within(preview).getByText("The report was generated from the requested source."),
		).toBeVisible();
		expect(within(preview).getByText(/acp\.tool_call/)).toBeVisible();
		expect(within(preview).getByText("a".repeat(64))).toBeVisible();

		await user.click(
			within(preview).getByRole("button", { name: zhCN.work.timeline.viewArtifacts }),
		);
		await waitFor(() => expect(open).toHaveBeenCalledWith(identity("report")));
		expect(within(preview).getByRole("status")).toHaveTextContent(zhCN.work.timeline.completed);
		await user.click(
			within(preview).getByRole("button", { name: zhCN.work.timeline.revealDetails }),
		);
		await waitFor(() => expect(reveal).toHaveBeenCalledWith(identity("report")));
		expect(within(preview).getByRole("status")).toHaveTextContent(
			zhCN.work.result.actionUnsupported,
		);
		await user.click(within(preview).getByRole("button", { name: zhCN.work.download }));
		await waitFor(() => expect(saveAs).toHaveBeenCalledWith(identity("report")));
		expect(within(preview).getByRole("status")).toHaveTextContent(
			zhCN.work.timeline.runStatuses.cancelled,
		);

		await user.click(within(preview).getByRole("button", { name: /archive\.bin/ }));
		const unsupported = screen.getByRole("dialog", { name: "archive.bin" });
		expect(within(unsupported).getByText(zhCN.work.result.issues.unsupported)).toBeVisible();
		expect(read).toHaveBeenCalledTimes(2);
		await user.click(within(unsupported).getByRole("button", { name: /large\.txt/ }));
		const tooLarge = screen.getByRole("dialog", { name: "large.txt" });
		expect(within(tooLarge).getByText(zhCN.work.result.issues.unsupported)).toBeVisible();
		expect(read).toHaveBeenCalledTimes(2);
		await user.click(
			within(tooLarge).getByRole("button", {
				name: zhCN.work.result.close,
			}),
		);
		expect(screen.queryByRole("dialog", { name: "archive.bin" })).not.toBeInTheDocument();
	});

	it("revokes generated media URLs on artifact switch, close, and unmount", async () => {
		const user = userEvent.setup();
		const createObjectURL = vi.spyOn(URL, "createObjectURL");
		const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
		createObjectURL
			.mockReturnValueOnce("blob:first")
			.mockReturnValueOnce("blob:second")
			.mockReturnValueOnce("blob:third")
			.mockReturnValueOnce("blob:fourth");
		const artifacts = [
			artifact("first", "first.png", "image/png", 3),
			artifact("second", "second.mp4", "video/mp4", 3),
			artifact("third", "third.mp3", "audio/mpeg", 3),
			artifact("fourth", "fourth.pdf", "application/pdf", 3),
		];
		const read = vi.fn(async ({ artifactId }) => {
			const artifact = artifacts.find((candidate) => candidate.id === artifactId);
			if (!artifact) throw new Error("missing test artifact");
			return {
				artifact,
				offset: 0,
				nextOffset: 3,
				eof: true,
				base64: btoa("bin"),
			};
		});
		const view = renderWork({
			runs: [
				{
					...run("completed", "completed"),
					artifacts,
				},
			],
			artifact: {
				read,
				open: vi.fn(async () => ({ outcome: "completed" as const })),
				reveal: vi.fn(async () => ({ outcome: "completed" as const })),
				saveAs: vi.fn(async () => ({ outcome: "completed" as const })),
			},
		});

		await user.click(screen.getByRole("button", { name: /查看成果: first\.png/ }));
		await screen.findByRole("img", { name: "first.png" });
		await user.click(
			within(screen.getByRole("dialog", { name: "first.png" })).getByRole("button", {
				name: /second\.mp4/,
			}),
		);
		const secondPreview = screen.getByRole("dialog", { name: "second.mp4" });
		await waitFor(() => expect(within(secondPreview).getByLabelText("second.mp4")).toBeVisible());
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");

		await user.click(
			within(screen.getByRole("dialog", { name: "second.mp4" })).getByRole("button", {
				name: zhCN.work.result.close,
			}),
		);
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
		await user.click(screen.getByRole("button", { name: /查看成果: third\.mp3/ }));
		const thirdPreview = screen.getByRole("dialog", { name: "third.mp3" });
		await waitFor(() => expect(within(thirdPreview).getByLabelText("third.mp3")).toBeVisible());
		await user.click(
			within(screen.getByRole("dialog", { name: "third.mp3" })).getByRole("button", {
				name: /fourth\.pdf/,
			}),
		);
		expect(await screen.findByTitle("fourth.pdf")).toHaveAttribute("sandbox");
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:third");

		view.unmount();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fourth");
	});

	it("downloads through a bounded browser Blob when native Save As is unsupported", async () => {
		const user = userEvent.setup();
		const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
		const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => undefined);
		const read = vi.fn(async () => ({
			artifact: artifact("download", "nested/report.bin", "application/octet-stream", 3),
			offset: 0,
			nextOffset: 3,
			eof: true,
			base64: btoa("bin"),
		}));
		const saveAs = vi.fn(async () => ({ outcome: "unsupported" as const }));
		renderWork({
			runs: [
				{
					...run("completed", "completed"),
					artifacts: [artifact("download", "nested/report.bin", "application/octet-stream", 3)],
				},
			],
			artifact: {
				read,
				open: vi.fn(async () => ({ outcome: "completed" as const })),
				reveal: vi.fn(async () => ({ outcome: "completed" as const })),
				saveAs,
			},
		});

		await user.click(screen.getByRole("button", { name: /查看成果: nested\/report\.bin/ }));
		const preview = screen.getByRole("dialog", { name: "nested/report.bin" });
		await user.click(within(preview).getByRole("button", { name: zhCN.work.download }));
		await waitFor(() => expect(click).toHaveBeenCalledOnce());
		expect(saveAs).toHaveBeenCalledWith(identity("download"));
		expect(read).toHaveBeenCalledWith({ ...identity("download"), offset: 0, length: 1024 * 1024 });
		expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe("report.bin");
		expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
		await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:download"));
		expect(within(preview).getByRole("status")).toHaveTextContent(zhCN.work.timeline.completed);

		click.mockRestore();
		createObjectURL.mockRestore();
		revokeObjectURL.mockRestore();
	});

	it("surfaces malformed read ranges and artifact action failures", async () => {
		const user = userEvent.setup();
		renderWork({
			runs: [
				{
					...run("completed", "completed"),
					artifacts: [artifact("bad", "bad.txt", "text/plain", 1)],
				},
			],
			artifact: {
				read: vi.fn(async () => ({
					artifact: artifact("bad", "bad.txt", "text/plain", 1),
					offset: 0,
					nextOffset: 1,
					eof: true,
					base64: "",
				})),
				open: vi.fn(async () => {
					throw new Error("open failed");
				}),
				reveal: vi.fn(async () => ({ outcome: "completed" as const })),
				saveAs: vi.fn(async () => ({ outcome: "completed" as const })),
			},
		});
		await user.click(screen.getByRole("button", { name: /查看成果: bad\.txt/ }));
		const preview = screen.getByRole("dialog", { name: "bad.txt" });
		expect(await within(preview).findByText(zhCN.work.result.issues.corrupted)).toHaveAttribute(
			"role",
			"alert",
		);
		await user.click(
			within(preview).getByRole("button", { name: zhCN.work.timeline.viewArtifacts }),
		);
		expect(await within(preview).findByText(zhCN.work.result.issues.unavailable)).toHaveAttribute(
			"role",
			"alert",
		);
	});

	it("localizes missing and pre-verified corruption without exposing Host reasons", async () => {
		const user = userEvent.setup();
		const read = vi.fn(async () => {
			throw { kind: "not_found", reason: "artifact_not_found" };
		});
		renderWork({
			runs: [
				{
					...run("completed", "completed"),
					artifacts: [
						artifact("missing", "missing.txt", "text/plain", 1),
						artifact("corrupt", "corrupt.txt", "text/plain", 1, "verification_failed"),
					],
				},
			],
			artifact: {
				read,
				open: vi.fn(async () => ({ outcome: "completed" as const })),
				reveal: vi.fn(async () => ({ outcome: "completed" as const })),
				saveAs: vi.fn(async () => ({ outcome: "completed" as const })),
			},
		});

		await user.click(screen.getByRole("button", { name: /查看成果: missing\.txt/ }));
		let preview = screen.getByRole("dialog", { name: "missing.txt" });
		expect(await within(preview).findByText(zhCN.work.result.issues.missing)).toBeVisible();
		expect(within(preview).queryByText("artifact_not_found")).not.toBeInTheDocument();
		await user.click(within(preview).getByRole("button", { name: /corrupt\.txt/ }));
		preview = screen.getByRole("dialog", { name: "corrupt.txt" });
		expect(within(preview).getByText(zhCN.work.result.issues.corrupted)).toBeVisible();
		expect(read).toHaveBeenCalledOnce();
	});
});

function identity(artifactId: string) {
	return { conversationId: "conversation-1", runId: "completed", artifactId };
}
