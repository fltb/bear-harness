import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import { createQuery, QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import type { RunInfo } from "../src/stores/ipc.js";
import { ThreadHead } from "../src/ThreadHead.js";
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
	controller: "attached",
	actions:
		status === "running"
			? ["steer", "interrupt", "cancel"]
			: status === "needs_user"
				? ["respondPermission", "cancel"]
				: status === "interrupted"
					? ["resume", "cancel"]
					: [],
	artifacts: [],
	evidence: [],
});

function renderWork(overrides: Partial<CompanionStore> = {}, showPermission = false) {
	const steer = vi.fn(() => Promise.resolve({ outcome: "injected" as const }));
	const interrupt = vi.fn(() => Promise.resolve());
	const resume = vi.fn(() => Promise.resolve());
	const cancel = vi.fn(() => Promise.resolve());
	const respondPermission = vi.fn(() => Promise.resolve());
	const { run: runOverrides, ...storeOverrides } = overrides;
	const store: CompanionStore = {
		activeConversationId: "conversation-1",
		errorMetadata: null,
		conversations: [],
		activeTimeline: [],
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
			observeDetail: (runId: () => string, cursor?: () => string | undefined) =>
				createQuery(() => ({
					queryKey: ["test-run", runId(), cursor?.()],
					queryFn: async () => ({
						run: store.runs.find((item) => item.id === runId())!,
						instruction: "Inspect the declared inputs and produce a report",
						inputPaths: [],
						evidence: [],
					}),
				})),
			observeHistory: () =>
				createQuery(() => ({
					queryKey: ["test-run-history"],
					queryFn: async () => ({ runs: [] }),
				})),
			retryDelivery: vi.fn(async () => store.runs[0]!),
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
			...runOverrides,
		},
		...storeOverrides,
	} as unknown as CompanionStore;
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const view = render(() => (
		<QueryClientProvider client={queryClient}>
			<DesktopProvider store={store}>
				<ThreadHead sceneLabel="Scene" />
				<WorkTimelineItem messageId="message-1" />
				<ArtifactPreview />
				{showPermission ? <PermissionLayer /> : null}
			</DesktopProvider>
		</QueryClientProvider>
	));
	return { store, steer, interrupt, resume, cancel, respondPermission, unmount: view.unmount };
}

describe("work timeline controls", () => {
	it("keeps terminal states distinct and exposes supported controls in task details", async () => {
		const user = userEvent.setup();
		const actions = renderWork();
		for (const status of ["completed", "failed", "cancelled", "forced_termination"] as const) {
			const card = screen.getByRole("article", { name: `${status} task` });
			expect(within(card).getByText(zhCN.work.timeline.runStatuses[status])).toBeVisible();
		}
		const running = screen.getByRole("article", { name: "running task" });
		await user.click(
			within(running).getByRole("button", { name: zhCN.work.timeline.revealDetails }),
		);
		const detail = await screen.findByRole("region", { name: zhCN.work.task.details });
		const input = await within(detail).findByRole("textbox", { name: zhCN.work.steerInputLabel });
		await user.type(input, "continue carefully");
		await user.click(within(detail).getByRole("button", { name: zhCN.work.timeline.steer }));
		await waitFor(() => expect(input).toHaveValue(""));
		expect(within(detail).getByRole("status")).toHaveTextContent(
			zhCN.work.task.steerOutcomes.injected,
		);
		await user.click(within(detail).getByRole("button", { name: zhCN.work.timeline.interrupt }));
		expect(actions.interrupt).toHaveBeenCalledWith("running");
		expect(
			within(detail).queryByRole("button", { name: zhCN.work.timeline.resume }),
		).not.toBeInTheDocument();
	});

	it("makes text-only results inspectable without claiming files were delivered", async () => {
		const user = userEvent.setup();
		renderWork({
			runs: [
				{
					...run("completed", "completed"),
					summary: "The analysis is ready; no report was saved.",
				},
			],
		});
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.revealDetails }));
		const detail = await screen.findByRole("region", { name: zhCN.work.task.details });
		expect(
			await within(detail).findByText("The analysis is ready; no report was saved."),
		).toBeVisible();
		expect(within(detail).getByText(zhCN.work.task.noArtifacts)).toBeVisible();
		expect(within(detail).getByText(zhCN.work.task.completionNotice)).toBeVisible();
		expect(within(detail).getByText(zhCN.work.task.deliveryPending)).toBeVisible();
		expect(
			within(detail).queryByRole("button", { name: zhCN.work.timeline.resume }),
		).not.toBeInTheDocument();
		expect(
			within(detail).queryByRole("button", { name: zhCN.work.task.retryDelivery }),
		).not.toBeInTheDocument();
	});

	it("preserves in-flight instruction drafts and exposes a real control failure after reopening", async () => {
		const user = userEvent.setup();
		let rejectSteer!: (reason: Error) => void;
		const pending = new Promise<never>((_resolve, reject) => {
			rejectSteer = reject;
		});
		renderWork({
			runs: [run("running", "running")],
			run: { steer: vi.fn(() => pending) } as unknown as CompanionStore["run"],
		});
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.revealDetails }));
		let detail = await screen.findByRole("region", { name: zhCN.work.task.details });
		const input = await within(detail).findByRole("textbox", { name: zhCN.work.steerInputLabel });
		await user.type(input, "Keep the original source");
		await user.click(within(detail).getByRole("button", { name: zhCN.work.timeline.steer }));
		expect(
			within(detail).getByRole("button", { name: zhCN.work.timeline.interrupt }),
		).toBeDisabled();
		await user.type(input, " and include references");
		rejectSteer(new Error("executor_controller_unavailable"));
		expect(await within(detail).findByRole("alert")).toHaveTextContent(
			"executor_controller_unavailable",
		);
		await user.click(screen.getByRole("button", { name: zhCN.work.task.close }));
		await user.click(screen.getByRole("button", { name: zhCN.work.timeline.revealDetails }));
		detail = await screen.findByRole("region", { name: zhCN.work.task.details });
		expect(
			await within(detail).findByRole("textbox", { name: zhCN.work.steerInputLabel }),
		).toHaveValue("Keep the original source and include references");
		expect(within(detail).getByRole("alert")).toHaveTextContent("executor_controller_unavailable");
	});

	it("suppresses only the fallback task already represented by a native delegate receipt", () => {
		renderWork({
			runs: [
				run("represented", "running"),
				{ ...run("pending", "enqueued"), title: "Pending admission projection" },
			],
			activeTimeline: [
				{
					kind: "entry",
					id: "receipt-entry",
					entry: {
						type: "message",
						id: "receipt-entry",
						parentId: null,
						timestamp,
						message: {
							role: "toolResult",
							toolCallId: "native-call",
							toolName: "host_delegate",
							content: [],
							details: { ok: true, data: { accepted: true, runId: "represented", executor: "pi" } },
							isError: false,
							timestamp: Date.parse(timestamp),
						},
					},
				},
			] as CompanionStore["activeTimeline"],
		});
		expect(screen.queryByText("running task")).not.toBeInTheDocument();
		expect(screen.getByText("Pending admission projection")).toBeVisible();
	});

	it("keeps an interrupted background task discoverable without changing conversations", async () => {
		const user = userEvent.setup();
		const actions = renderWork({
			runs: [{ ...run("paused", "interrupted"), conversationId: "origin-background" }],
			conversations: [
				{
					conversationId: "origin-background",
					name: "Background research",
					created: timestamp,
					modified: timestamp,
					messageCount: 0,
					firstMessage: "",
					isStreaming: false,
				},
			],
		});
		expect(screen.queryByText("interrupted task")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /1/ }));
		const panel = screen.getByRole("region", { name: zhCN.threadHead.runningWork });
		expect(within(panel).getByText(/Background research/)).toBeVisible();
		await user.click(within(panel).getByRole("button", { name: zhCN.work.timeline.revealDetails }));
		const detail = await screen.findByRole("region", { name: zhCN.work.task.details });
		await user.click(
			await within(detail).findByRole("button", { name: zhCN.work.timeline.resume }),
		);
		expect(actions.resume).toHaveBeenCalledWith("paused", undefined);
		expect(actions.store.activeConversationId).toBe("conversation-1");
	});

	it("keeps permission decisions in a blocking system-action card", async () => {
		const user = userEvent.setup();
		const actions = renderWork({}, true);
		expect(screen.getByRole("dialog", { name: zhCN.work.timeline.needsYou })).toBeVisible();
		const allowOnce = screen.getByRole("button", { name: "Allow" });
		expect(allowOnce).toHaveAccessibleDescription("allow_once");
		await user.click(allowOnce);
		expect(actions.respondPermission).toHaveBeenLastCalledWith(
			"needs-user",
			"permission-1",
			"allow",
		);
		const allowSession = screen.getByRole("button", { name: "Allow for session" });
		expect(allowSession).toHaveAccessibleDescription("allow_always");
		await user.click(allowSession);
		expect(actions.respondPermission).toHaveBeenLastCalledWith(
			"needs-user",
			"permission-1",
			"allow_always",
		);
		const allowPattern = screen.getByRole("button", { name: "Allow command pattern" });
		expect(allowPattern).toHaveAccessibleDescription("allow_always");
		await user.click(allowPattern);
		expect(actions.respondPermission).toHaveBeenLastCalledWith(
			"needs-user",
			"permission-1",
			"accept_execpolicy_amendment",
		);
		const deny = screen.getByRole("button", { name: "Deny" });
		expect(deny).toHaveAccessibleDescription("reject_once");
		await user.click(deny);
		expect(actions.respondPermission).toHaveBeenLastCalledWith(
			"needs-user",
			"permission-1",
			"deny",
		);
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
		await waitFor(() =>
			expect(
				within(secondPreview).getByLabelText("second.mp4", { selector: "video" }),
			).toBeVisible(),
		);
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");

		await user.click(
			within(screen.getByRole("dialog", { name: "second.mp4" })).getByRole("button", {
				name: zhCN.work.result.close,
			}),
		);
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
		await user.click(screen.getByRole("button", { name: /查看成果: third\.mp3/ }));
		const thirdPreview = screen.getByRole("dialog", { name: "third.mp3" });
		await waitFor(() =>
			expect(within(thirdPreview).getByLabelText("third.mp3", { selector: "audio" })).toBeVisible(),
		);
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
