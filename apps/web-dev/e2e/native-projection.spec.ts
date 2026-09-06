import { zhCN } from "@bear-harness/i18n/locales";
import type { PiSessionEntry } from "@bear-harness/protocol";
import { expect, type Page, test } from "playwright/test";
import {
	activeConversationId,
	ensureReadyForConversation,
	getBootstrap,
	projectPiEntries,
	providerHold,
	sendMessage,
} from "./helpers";

async function nativeSnapshot(page: Page, conversationId: string) {
	const { token } = await getBootstrap(page);
	const response = await page.request.post("/rpc/conversation.open", {
		headers: { "x-bear-web-dev-token": token },
		data: { conversationId },
	});
	await expect(response).toBeOK();
	const envelope = await response.json();
	expect(envelope).toMatchObject({ ok: true });
	return envelope.data.branch as { entries: PiSessionEntry[]; hasMoreBefore: boolean };
}

test("streamed native tool disclosure stays open through execution and restores exact persisted content", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await ensureReadyForConversation(page);
	const conversationId = await activeConversationId(page);
	const hold = providerHold(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const args = {
		action: "update",
		changes: [{ path: "/display/expressionId", value: "reflective" }],
	};
	const renderedArgs = JSON.stringify(args, null, 2);
	const renderedPartialArgs = JSON.stringify(
		{ action: "update", changes: [{ path: "/display/expressionId" }] },
		null,
		2,
	);
	const resultText = "Character and Display state updated.";
	const pendingName = `host_state ${zhCN.messages.toolActivity.pending}`;
	const completedName = `host_state ${zhCN.messages.toolActivity.completed}`;
	try {
		await sendMessage(page, `E2E_NATIVE_DISCLOSURE_${hold.id}`);
		await hold.entered();
		const pending = thread.getByRole("article", { name: pendingName, exact: true });
		await expect(pending).toBeVisible();
		await expect(pending.getByText(renderedPartialArgs, { exact: true })).toBeHidden();
		await pending.getByText("host_state", { exact: true }).click();
		await expect(pending.getByText(renderedPartialArgs, { exact: true })).toBeVisible();
		await expect(pending.getByText(renderedArgs, { exact: true })).toHaveCount(0);
		await expect(pending.getByText(zhCN.messages.native.noResult, { exact: true })).toBeVisible();
		const toolCallId = await pending.getAttribute("data-tool-call-id");
		expect(toolCallId).toEqual(expect.any(String));
		const beforeExecution = await nativeSnapshot(page, conversationId);
		expect(
			beforeExecution.entries.filter(
				(entry) => entry.type === "message" && entry.message.role === "toolResult",
			),
		).toEqual([]);

		await hold.release();
		const completed = thread.getByRole("article", { name: completedName, exact: true });
		await expect(completed).toHaveAttribute("data-tool-call-id", toolCallId!);
		// No second click: live-to-persisted reconciliation must keep this disclosure open.
		await expect(completed.getByText(renderedArgs, { exact: true })).toBeVisible();
		await expect(completed.getByText(resultText, { exact: true })).toBeVisible();
		await expect(completed.getByText(zhCN.messages.native.noResult, { exact: true })).toHaveCount(
			0,
		);
		await expect(
			thread
				.getByRole("article", { name: "极昼", exact: true })
				.getByText(`E2E_NATIVE_DISCLOSURE_DONE_${hold.id}`, { exact: true }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeHidden();
		const settled = await nativeSnapshot(page, conversationId);
		const toolResult = settled.entries.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId,
		);
		expect(toolResult).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "host_state",
				isError: false,
				content: [{ type: "text", text: resultText }],
			},
		});
		const nativeCall = settled.entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? entry.message.content.filter((part) => part.type === "toolCall" && part.id === toolCallId)
				: [],
		);
		expect(nativeCall).toEqual([
			expect.objectContaining({ type: "toolCall", name: "host_state", arguments: args }),
		]);
		await expect(completed).toHaveAttribute("data-pi-entry-id", toolResult!.id);
		await expect(completed.getByText(renderedArgs, { exact: true })).toBeVisible();
		await expect(completed.getByText(resultText, { exact: true })).toBeVisible();

		await page.reload();
		await activeConversationId(page, conversationId);
		await expect(completed).toHaveAttribute("data-pi-entry-id", toolResult!.id);
		await completed.getByText("host_state", { exact: true }).click();
		await expect(completed.getByText(renderedArgs, { exact: true })).toBeVisible();
		await expect(completed.getByText(resultText, { exact: true })).toBeVisible();
	} catch (error) {
		try {
			await hold.release();
		} catch {
			// Timeout may close the request context; preserve the original failure.
		}
		throw error;
	}
});

test("native history pagination restores earlier turns without moving the visible entry and survives snapshot refresh", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await ensureReadyForConversation(page);
	const conversationId = await activeConversationId(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	const firstMessage = thread
		.getByRole("article", { name: zhCN.messages.you, exact: true })
		.filter({
			has: page.getByText("E2E_NATIVE_HISTORY_1", { exact: true }),
		});
	// Thirty real turns produce sixty native messages, beyond the fifty-entry open snapshot.
	for (let turn = 1; turn <= 30; turn++) {
		await sendMessage(page, `E2E_NATIVE_HISTORY_${turn}`);
		await expect(assistant.getByText(`E2E_NATIVE_REPLY_${turn}`, { exact: true })).toHaveCount(1);
		await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeHidden();
	}
	await expect(firstMessage).toHaveCount(1);
	const firstEntryId = await firstMessage.getAttribute("data-pi-entry-id");
	const { token } = await getBootstrap(page);
	const historyResponse = await page.request.post("/rpc/conversation.history", {
		headers: { "x-bear-web-dev-token": token },
		data: { conversationId, limit: 100 },
	});
	await expect(historyResponse).toBeOK();
	const history = await historyResponse.json();
	expect(history).toMatchObject({ ok: true });
	const messages = projectPiEntries(history.data.entries).filter(
		(entry) => entry.role === "user" || entry.role === "assistant",
	);
	expect(messages.filter((entry) => entry.role === "user")).toHaveLength(30);
	expect(messages.filter((entry) => entry.role === "assistant")).toHaveLength(30);

	await page.reload();
	await activeConversationId(page, conversationId);
	const bounded = await nativeSnapshot(page, conversationId);
	expect(bounded.hasMoreBefore).toBe(true);
	expect(bounded.entries).toHaveLength(50);
	await expect(firstMessage).toHaveCount(0);
	const existing = projectPiEntries(bounded.entries).find((entry) => entry.role === "user");
	if (!existing?.text) throw new Error("Bounded native history has no user message to anchor");
	const anchor = thread.getByRole("article", { name: zhCN.messages.you, exact: true }).filter({
		has: page.getByText(existing.text, { exact: true }),
	});
	const loadOlder = thread.getByRole("button", {
		name: zhCN.messages.native.loadOlder,
		exact: true,
	});
	await loadOlder.scrollIntoViewIfNeeded();
	await expect(anchor).toBeInViewport();
	await expect(anchor).toHaveAttribute("data-pi-entry-id", existing.id);
	const before = await anchor.boundingBox();
	if (!before) throw new Error("Native history anchor has no visible bounds");
	await loadOlder.click();
	await expect(loadOlder).toBeHidden();
	await expect(firstMessage).toHaveAttribute("data-pi-entry-id", firstEntryId!);
	await expect(anchor).toHaveAttribute("data-pi-entry-id", existing.id);
	await expect(anchor).toBeInViewport();
	await expect
		.poll(async () => {
			const after = await anchor.boundingBox();
			return after ? Math.abs(after.y - before.y) : Number.POSITIVE_INFINITY;
		})
		.toBeLessThanOrEqual(2);
	await firstMessage.scrollIntoViewIfNeeded();
	await expect(firstMessage).toBeInViewport();
	await expect(firstMessage.getByText("E2E_NATIVE_HISTORY_1", { exact: true })).toBeVisible();

	// Loaded ancestry belongs to this mounted Query. A new native turn refreshes
	// its bounded snapshot; a whole browser reload intentionally starts a new window.
	const refreshed = page.waitForResponse(async (response) => {
		if (
			!response.url().endsWith("/rpc/conversation.open") ||
			response.request().method() !== "POST"
		)
			return false;
		const envelope = await response.json();
		return (
			envelope.ok === true &&
			projectPiEntries(envelope.data.branch.entries).some(
				(entry) => entry.role === "assistant" && entry.text?.trim() === "E2E_NATIVE_REPLY_31",
			)
		);
	});
	await sendMessage(page, "E2E_NATIVE_HISTORY_31");
	await expect(assistant.getByText("E2E_NATIVE_REPLY_31", { exact: true })).toBeVisible();
	const refreshedSnapshot = await (await refreshed).json();
	const refreshedReply = projectPiEntries(refreshedSnapshot.data.branch.entries).find(
		(entry) => entry.role === "assistant" && entry.text?.trim() === "E2E_NATIVE_REPLY_31",
	);
	if (!refreshedReply) throw new Error("Refreshed native snapshot is missing the completed reply");
	await expect(
		assistant.filter({ has: page.getByText("E2E_NATIVE_REPLY_31", { exact: true }) }),
	).toHaveAttribute("data-pi-entry-id", refreshedReply.id);
	await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeHidden();
	await expect(firstMessage).toHaveAttribute("data-pi-entry-id", firstEntryId!);
	await expect(anchor).toHaveAttribute("data-pi-entry-id", existing.id);
	await expect(loadOlder).toHaveCount(0);
	await firstMessage.scrollIntoViewIfNeeded();
	await expect(firstMessage.getByText("E2E_NATIVE_HISTORY_1", { exact: true })).toBeVisible();
});
