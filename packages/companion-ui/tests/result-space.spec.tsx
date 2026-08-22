import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createEffect, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
	RESULT_LOCATE_EVENT,
	type ResultLocateDetail,
	type ResultSelection,
	ResultSpace,
	type ResultSpaceApi,
	ResultSpaceProvider,
	useResultSpace,
} from "../src/features/ResultSpace.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Exposes the provider API to the test body (must run inside the provider). */
function ApiProbe(props: { onReady: (api: ResultSpaceApi) => void }) {
	const api = useResultSpace();
	createEffect(() => props.onReady(api));
	return null;
}

function Harness(props: {
	store: CompanionStore;
	onApi?: (api: ResultSpaceApi) => void;
	extra?: () => unknown;
}) {
	return (
		<DesktopProvider store={props.store}>
			<ResultSpaceProvider>
				<ApiProbe onReady={(api) => props.onApi?.(api)} />
				{props.extra?.()}
				<ResultSpace />
			</ResultSpaceProvider>
		</DesktopProvider>
	);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function message(id: string, content: string) {
	return {
		id,
		role: "user",
		adoptedVersionId: `${id}-v1`,
		createdAt: "2026-08-16T00:00:00Z",
		versions: [
			{
				id: `${id}-v1`,
				role: "user",
				content,
				editedByUser: false,
				createdAt: "2026-08-16T00:00:00Z",
				adopted: true,
			},
		],
	};
}

function artifact(
	id: string,
	logicalName: string,
	producerRunId: string,
	mime: string,
	status: "verified" | "created" = "verified",
) {
	return {
		id,
		logicalName,
		mime,
		bytes: 16,
		sha256: `sha-${id}`,
		status,
		producerRunId,
		createdAt: "2026-08-16T00:00:00Z",
	};
}

function commission(id: string, triggerMessageId: string, title: string) {
	return {
		id,
		conversationId: "conversation-1",
		triggerMessageId,
		status: "approved",
		createdAt: "2026-08-16T00:00:00Z",
		draft: {
			title,
			description: "work",
			reads: [],
			writes: [],
			networkAllowed: false,
			toolNames: [],
			hash: "hash",
		},
	};
}

function createResultStore() {
	const [activeConversationId, setActiveConversationId] = createSignal("conversation-1");
	const read = vi.fn((artifactId: string) =>
		Promise.resolve({
			logicalName: artifactId,
			mime: "text/plain",
			base64: btoa(`preview-of-${artifactId}`),
		}),
	);
	const url = vi.fn(() => Promise.resolve(""));
	const download = vi.fn(() => Promise.resolve());
	const store = {
		get activeConversationId() {
			return activeConversationId();
		},
		activePiTimeline: {
			entries: [
				{
					id: "message-42",
					parentId: null,
					timestamp: "2026-08-16T00:00:00Z",
					kind: "message",
					role: "user",
					text: "把三份会议记录整理成周报",
				},
			],
		},
		runs: [
			{ id: "run-1", commissionId: "commission-1", executorProfile: "pi", status: "completed" },
			{ id: "run-2", commissionId: "commission-2", executorProfile: "pi", status: "completed" },
		],
		commission: {
			commissions: () => [
				commission("commission-1", "message-42", "项目进展报告"),
				commission("commission-2", "message-99", "另一个任务"),
			],
		},
		artifact: {
			artifacts: () => [
				artifact("artifact-a1", "weekly-summary.md", "run-1", "text/markdown"),
				artifact("artifact-a2", "weekly-summary.pdf", "run-1", "application/pdf"),
				artifact("artifact-b1", "other-report.md", "run-2", "text/markdown"),
			],
			read,
			url,
			download,
		},
		run: { pendingPermissions: () => [] },
	} as unknown as CompanionStore;
	return { store, setActiveConversationId, read, url, download };
}

const RUN_1_SELECTION: ResultSelection = {
	conversationId: "conversation-1",
	triggerMessageId: "message-42",
	commissionId: "commission-1",
	runId: "run-1",
	artifactId: "artifact-a1",
};

async function openWith(
	api: ResultSpaceApi,
	selection: ResultSelection = RUN_1_SELECTION,
	focusReturn?: HTMLElement,
) {
	api.open(selection, focusReturn);
	await waitFor(() =>
		expect(screen.getByRole("region", { name: zhCN.work.result.title })).toBeVisible(),
	);
}

function requireDefined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} was not initialized`);
	return value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResultSpace", () => {
	it("opens with the exact selection and renders only the selected run's artifacts", async () => {
		const { store, read } = createResultStore();
		let api: ResultSpaceApi | undefined;
		render(() => <Harness store={store} onApi={(value) => (api = value)} />);
		await waitFor(() => expect(api).toBeDefined());

		const resultSpace = requireDefined(api, "ResultSpace API");
		resultSpace.open(RUN_1_SELECTION);
		await waitFor(() =>
			expect(screen.getByRole("region", { name: zhCN.work.result.title })).toBeVisible(),
		);
		const region = screen.getByRole("region", { name: zhCN.work.result.title });
		const selectedTab = within(region).getByRole("tab", { name: "weekly-summary.md" });
		expect(selectedTab).toHaveAttribute("aria-selected", "true");
		const selectedPanel = within(region).getByRole("tabpanel");
		expect(selectedTab.id).not.toBe("");
		expect(selectedPanel.id).not.toBe("");
		expect(selectedTab).toHaveAttribute("aria-controls", selectedPanel.id);
		expect(within(region).getByRole("tab", { name: "weekly-summary.pdf" })).toBeVisible();
		// Artifacts of other runs are never rendered.
		expect(within(region).queryByRole("tab", { name: "other-report.md" })).toBeNull();
		// Source-message summary comes from the trigger message, not recency.
		expect(within(region).getByText("来自：把三份会议记录整理成周报")).toBeVisible();
		// The selection is exact.
		expect(resultSpace.selection()).toEqual(RUN_1_SELECTION);

		// Inline text preview reads the host bytes and renders them as text.
		await waitFor(() => expect(read).toHaveBeenCalledWith("artifact-a1"));
		expect(await screen.findByText("preview-of-artifact-a1")).toBeVisible();
	});

	it("keeps the per-run last-viewed artifact tab across close and reopen", async () => {
		const { store } = createResultStore();
		let api: ResultSpaceApi | undefined;
		const user = userEvent.setup();
		render(() => <Harness store={store} onApi={(value) => (api = value)} />);
		await waitFor(() => expect(api).toBeDefined());

		const resultSpace = requireDefined(api, "ResultSpace API");
		await openWith(resultSpace);
		await user.click(screen.getByRole("tab", { name: "weekly-summary.pdf" }));
		expect(screen.getByRole("tab", { name: "weekly-summary.pdf" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(resultSpace.selection()?.artifactId).toBe("artifact-a2");

		resultSpace.close();
		await waitFor(() =>
			expect(screen.queryByRole("region", { name: zhCN.work.result.title })).toBeNull(),
		);

		// Reopen from the same action line: last-viewed tab wins over the
		// artifactId the caller passed.
		await openWith(resultSpace, { ...RUN_1_SELECTION, artifactId: "artifact-a1" });
		expect(screen.getByRole("tab", { name: "weekly-summary.pdf" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(resultSpace.selection()?.artifactId).toBe("artifact-a2");
	});

	it("closes via the close button without side effects and restores opener focus", async () => {
		const { store, download, url } = createResultStore();
		let api: ResultSpaceApi | undefined;
		let opener: HTMLButtonElement | undefined;
		const user = userEvent.setup();
		render(() => (
			<Harness
				store={store}
				onApi={(value) => (api = value)}
				extra={() => (
					<button type="button" ref={(el) => (opener = el)}>
						opener
					</button>
				)}
			/>
		));
		await waitFor(() => expect(api).toBeDefined());
		expect(opener).toBeDefined();
		const resultSpace = requireDefined(api, "ResultSpace API");
		const openerElement = requireDefined(opener, "result opener");
		openerElement.focus();
		expect(document.activeElement).toBe(openerElement);

		await openWith(resultSpace, RUN_1_SELECTION, openerElement);
		await user.click(screen.getByRole("button", { name: zhCN.work.result.close }));
		await waitFor(() =>
			expect(screen.queryByRole("region", { name: zhCN.work.result.title })).toBeNull(),
		);

		expect(resultSpace.selection()).toBeUndefined();
		// Closing only clears the view: no artifact mutation, no host calls.
		expect(download).not.toHaveBeenCalled();
		expect(url).not.toHaveBeenCalled();
		// Focus returns to the opener.
		expect(document.activeElement).toBe(openerElement);
	});

	it("closes via Escape and restores focus to the opener", async () => {
		const { store } = createResultStore();
		let api: ResultSpaceApi | undefined;
		let opener: HTMLButtonElement | undefined;
		const user = userEvent.setup();
		render(() => (
			<Harness
				store={store}
				onApi={(value) => (api = value)}
				extra={() => (
					<button type="button" ref={(el) => (opener = el)}>
						opener
					</button>
				)}
			/>
		));
		await waitFor(() => expect(api).toBeDefined());
		const resultSpace = requireDefined(api, "ResultSpace API");
		const openerElement = requireDefined(opener, "result opener");
		openerElement.focus();

		await openWith(resultSpace, RUN_1_SELECTION, openerElement);
		await user.keyboard("{Escape}");
		await waitFor(() =>
			expect(screen.queryByRole("region", { name: zhCN.work.result.title })).toBeNull(),
		);
		expect(document.activeElement).toBe(openerElement);
	});

	it("isolates selections across conversations and restores each conversation's own view", async () => {
		const { store, setActiveConversationId } = createResultStore();
		let api: ResultSpaceApi | undefined;
		render(() => <Harness store={store} onApi={(value) => (api = value)} />);
		await waitFor(() => expect(api).toBeDefined());

		await openWith(requireDefined(api, "ResultSpace API"), RUN_1_SELECTION);
		expect(screen.getByRole("tab", { name: "weekly-summary.md" })).toBeVisible();

		// Switching to a conversation without a selection hides the column.
		setActiveConversationId("conversation-2");
		await waitFor(() =>
			expect(screen.queryByRole("region", { name: zhCN.work.result.title })).toBeNull(),
		);

		// The other conversation opens its own, unrelated result.
		await openWith(requireDefined(api, "ResultSpace API"), {
			conversationId: "conversation-2",
			triggerMessageId: "message-99",
			commissionId: "commission-2",
			runId: "run-2",
			artifactId: "artifact-b1",
		});
		expect(screen.getByRole("tab", { name: "other-report.md" })).toBeVisible();
		expect(screen.queryByRole("tab", { name: "weekly-summary.md" })).toBeNull();

		// Back to conversation-1: its own selection and tabs are restored.
		setActiveConversationId("conversation-1");
		await waitFor(() =>
			expect(screen.getByRole("tab", { name: "weekly-summary.md" })).toBeVisible(),
		);
		expect(screen.queryByRole("tab", { name: "other-report.md" })).toBeNull();
		expect(requireDefined(api, "ResultSpace API").selection()?.runId).toBe("run-1");
	});

	it("dispatches the locate event with the exact source message", async () => {
		const { store } = createResultStore();
		let api: ResultSpaceApi | undefined;
		const user = userEvent.setup();
		render(() => <Harness store={store} onApi={(value) => (api = value)} />);
		await waitFor(() => expect(api).toBeDefined());

		await openWith(requireDefined(api, "ResultSpace API"), RUN_1_SELECTION);
		const handler = vi.fn((event: Event) => event);
		window.addEventListener(RESULT_LOCATE_EVENT, handler);
		try {
			await user.click(screen.getByRole("button", { name: zhCN.work.result.locate }));
			expect(handler).toHaveBeenCalledTimes(1);
			const firstCall = handler.mock.calls[0];
			if (firstCall === undefined) throw new Error("locate event was not captured");
			const event = firstCall[0];
			if (!(event instanceof CustomEvent)) throw new Error("locate event was not a CustomEvent");
			const detail = (event as CustomEvent<ResultLocateDetail>).detail;
			expect(detail).toEqual({ conversationId: "conversation-1", messageId: "message-42" });
		} finally {
			window.removeEventListener(RESULT_LOCATE_EVENT, handler);
		}
	});

	it("shows the unavailable state when the run has no artifacts", async () => {
		const { store } = createResultStore();
		let api: ResultSpaceApi | undefined;
		render(() => <Harness store={store} onApi={(value) => (api = value)} />);
		await waitFor(() => expect(api).toBeDefined());

		await openWith(requireDefined(api, "ResultSpace API"), {
			...RUN_1_SELECTION,
			runId: "run-empty",
			artifactId: "missing",
		});
		expect(screen.getByText(zhCN.work.result.unavailable)).toBeVisible();
		expect(screen.queryByRole("tablist")).toBeNull();
	});

	it("previews images through the host-issued safe artifact URL", async () => {
		const { store, url, read } = createResultStore();
		url.mockResolvedValue("bear-artifact://artifact/artifact-img");
		(store.artifact as { artifacts: () => unknown[] }).artifacts = () => [
			artifact("artifact-img", "cover.png", "run-1", "image/png"),
		];
		let api: ResultSpaceApi | undefined;
		render(() => <Harness store={store} onApi={(value) => (api = value)} />);
		await waitFor(() => expect(api).toBeDefined());

		await openWith(requireDefined(api, "ResultSpace API"), {
			...RUN_1_SELECTION,
			artifactId: "artifact-img",
		});
		const image = await screen.findByRole("img", { name: "cover.png" });
		expect(image).toHaveAttribute("src", "bear-artifact://artifact/artifact-img");
		expect(read).not.toHaveBeenCalled();
	});
});
