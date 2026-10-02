import { zhCN } from "@bear-harness/i18n/locales";
import type {
	CharacterDraft,
	ConversationDetail,
	LivePush,
	PiAgentMessage,
} from "@bear-harness/protocol";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { StudioTrial } from "../src/features/studio/StudioTrial.js";
import type { CharacterApi } from "../src/stores/supplementary-api.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const copy = zhCN.studio;
const draft = {
	id: "trial~00000000-0000-4000-8000-000000000000",
	characterId: "trial",
	currentRevision: 4,
	files: { "assets/photo.png": { encoding: "base64", size: 3, sha256: "a".repeat(64) } },
	status: "draft",
	locale: "zh-CN",
	updatedAt: "2026-10-02",
} as CharacterDraft;
function setup() {
	let wake: (() => void) | undefined;
	const events: LivePush[] = [];
	let ended = false;
	const detail = {
		conversationId: "isolated",
		branch: { entries: [] },
		live: { isStreaming: false },
	} as unknown as ConversationDetail;
	const push = (event: LivePush) => {
		events.push(event);
		wake?.();
	};
	const api = {
		trialEvents: vi.fn(async (signal: AbortSignal) => ({
			async *[Symbol.asyncIterator]() {
				signal.addEventListener(
					"abort",
					() => {
						ended = true;
						wake?.();
					},
					{ once: true },
				);
				while (!ended) {
					if (events.length) yield events.shift()!;
					else
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
				}
			},
		})),
		trial: vi.fn(async (input: { action: string }) => {
			if (input.action === "send") detail.live.isStreaming = true;
			if (input.action === "abort" || input.action === "start") detail.live.isStreaming = false;
			return { trialId: "trial-1", detail: structuredClone(detail) };
		}),
	} as unknown as CharacterApi;
	return { api, detail, push };
}
it("routes native streaming only to the selected trial, stops, refreshes snapshots and starts a clean model session", async () => {
	const { api, detail, push } = setup();
	const user = userEvent.setup();
	const close = vi.fn();
	const view = render(() => (
		<StudioTrial
			api={api}
			draft={draft}
			models={[
				{ providerId: "p", modelId: "one", label: "One" },
				{ providerId: "p", modelId: "two", label: "Two" },
			]}
			onClose={close}
		/>
	));
	const start = await screen.findByRole("button", { name: copy.trialStart });
	await waitFor(() => expect(start).toBeEnabled());
	await user.click(start);
	const input = await screen.findByRole("textbox", { name: copy.trialMessage });
	fireEvent.input(input, { target: { value: "Hello" } });
	await user.click(screen.getByRole("button", { name: copy.trialSend }));
	await waitFor(() =>
		expect(api.trial).toHaveBeenCalledWith(
			expect.objectContaining({ action: "send", text: "Hello", trialId: "trial-1" }),
		),
	);
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "Native partial" }],
		timestamp: 1,
	} as PiAgentMessage;
	push({
		type: "studioTrial",
		trialId: "unrelated",
		event: { type: "message_update", message },
	} as LivePush);
	push({ type: "studioTrial", trialId: "trial-1", event: { type: "agent_start" } });
	push({
		type: "studioTrial",
		trialId: "trial-1",
		event: { type: "message_update", message },
	} as LivePush);
	await screen.findByText("Native partial");
	await user.click(screen.getByRole("button", { name: copy.trialStop }));
	await waitFor(() =>
		expect(api.trial).toHaveBeenCalledWith({ action: "abort", trialId: "trial-1" }),
	);
	detail.branch.entries = [
		{
			type: "message",
			id: "m",
			parentId: null,
			timestamp: "2026-10-02",
			message: { ...message, content: [{ type: "text", text: "Native settled" }] },
		},
	] as ConversationDetail["branch"]["entries"];
	push({
		type: "studioTrial",
		trialId: "trial-1",
		event: { type: "message_end", message },
	} as LivePush);
	push({ type: "studioTrial", trialId: "trial-1", event: { type: "agent_end", messages: [] } });
	await screen.findByText("Native settled");
	await waitFor(() => expect(screen.queryByText("Native partial")).toBeNull());
	await selectKobalteOption(
		user,
		screen.getByRole("button", { name: new RegExp(copy.trialModel) }),
		"p / two",
	);
	await user.click(screen.getByRole("button", { name: copy.trialReset }));
	await waitFor(() =>
		expect(api.trial).toHaveBeenCalledWith(
			expect.objectContaining({ action: "start", modelId: "two", expectedRevision: 4 }),
		),
	);
	expect(api.trial).toHaveBeenCalledWith({ action: "close", trialId: "trial-1" });
	await user.click(screen.getByRole("button", { name: zhCN.backstage.close }));
	expect(close).toHaveBeenCalled();
	view.unmount();
});
it("reports transport and send failures, keeps unsent input and reconnects to the authoritative snapshot", async () => {
	const { api } = setup();
	const user = userEvent.setup();
	vi.mocked(api.trialEvents).mockRejectedValueOnce(new Error("Connection unavailable"));
	const view = render(() => (
		<StudioTrial
			api={api}
			draft={draft}
			models={[{ providerId: "p", modelId: "one", label: "One" }]}
			onClose={() => {}}
		/>
	));
	await screen.findByText("Connection unavailable");
	await user.click(screen.getByRole("button", { name: copy.reconnect }));
	const start = screen.getByRole("button", { name: copy.trialStart });
	await waitFor(() => expect(start).toBeEnabled());
	await user.click(start);
	const input = await screen.findByRole("textbox", { name: copy.trialMessage });
	fireEvent.input(input, { target: { value: "Retry me" } });
	vi.mocked(api.trial).mockRejectedValueOnce({ reason: "Provider unavailable" });
	await user.click(screen.getByRole("button", { name: copy.trialSend }));
	await screen.findByText("Provider unavailable");
	expect(input).toHaveValue("Retry me");
	view.unmount();
});

it("uses native choice results as ordinary input and previews media from the draft package", async () => {
	const { api, detail } = setup();
	const user = userEvent.setup();
	const source = "media:\n  - id: photo\n    label: Draft photo\n    asset: assets/photo.png\n";
	detail.branch.entries = [
		{
			type: "message",
			id: "choice",
			message: {
				role: "toolResult",
				toolName: "host_choices",
				content: [{ type: "text", text: "Choice payload" }],
				details: {
					ok: true,
					data: { prompt: "Pick a drink", items: [{ label: "Tea", message: "I would like tea." }] },
				},
			},
		},
		{
			type: "message",
			id: "media",
			message: {
				role: "toolResult",
				toolName: "host_media",
				content: [{ type: "text", text: "Media payload" }],
				details: { ok: true, data: { mediaId: "photo" } },
			},
		},
	] as ConversationDetail["branch"]["entries"];
	api.draftFile = vi.fn(async () => new Uint8Array([1, 2, 3]));
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL() {
				return "blob:preview";
			}
			static revokeObjectURL() {}
		},
	);
	const view = render(() => (
		<StudioTrial
			api={api}
			draft={draft}
			source={source}
			models={[{ providerId: "p", modelId: "one", label: "One" }]}
			onClose={() => {}}
		/>
	));
	const start = await screen.findByRole("button", { name: copy.trialStart });
	await waitFor(() => expect(start).toBeEnabled());
	await user.click(start);
	await user.click(await screen.findByRole("button", { name: "Draft photo" }));
	await screen.findByRole("img", { name: "assets/photo.png" });
	await user.click(screen.getByRole("button", { name: copy.originalPreview }));
	await screen.findByRole("button", { name: copy.fitPreview });
	await user.click(
		within(screen.getByRole("dialog", { name: copy.preview })).getByRole("button", {
			name: zhCN.backstage.close,
		}),
	);
	await waitFor(() => expect(screen.getByRole("button", { name: "Tea" })).toBeEnabled());
	await user.click(screen.getByRole("button", { name: "Tea" }));
	await waitFor(() =>
		expect(api.trial).toHaveBeenCalledWith(
			expect.objectContaining({ action: "send", text: "I would like tea.", trialId: "trial-1" }),
		),
	);
	expect(api.draftFile).toHaveBeenCalledWith(draft.id, "assets/photo.png", "a".repeat(64));
	view.unmount();
	vi.unstubAllGlobals();
});
