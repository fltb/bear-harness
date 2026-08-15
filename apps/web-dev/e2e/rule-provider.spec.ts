import { expect, type Page, test } from "playwright/test";

interface SnapshotMessage {
	id: string;
	role: string;
	versions: Array<{ content: string }>;
}

interface ConversationSnapshot {
	conversation?: { messages?: SnapshotMessage[] };
}

async function rpc<T>(page: Page, token: string, channel: string, data: unknown): Promise<T> {
	const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
		headers: { "x-bear-web-dev-token": token },
		data,
	});
	const envelope = await response.json();
	if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
	return envelope.data as T;
}

test("rule provider exercises send and edited-history regeneration deterministically", async ({
	page,
}) => {
	await page.goto("/");
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversation = await rpc<{ id: string }>(page, bootstrap.token, "conversation.create:v1", {
		title: "Rule provider",
	});

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversation.id,
		text: "你是谁？",
	});
	await expect
		.poll(async () => {
			const snapshot = await rpc<ConversationSnapshot>(
				page,
				bootstrap.token,
				"snapshot.get:v1",
				{},
			);
			return snapshot.conversation?.messages?.at(-1)?.versions?.at(-1)?.content;
		})
		.toBe("我是 E2E Rule Provider。\n");

	const snapshot = await rpc<ConversationSnapshot>(page, bootstrap.token, "snapshot.get:v1", {});
	const userMessage = snapshot.conversation?.messages?.find((message) => message.role === "user");
	if (!userMessage) throw new Error("rule provider snapshot has no user message");
	await rpc(page, bootstrap.token, "message.edit:v1", {
		conversationId: conversation.id,
		messageId: userMessage.id,
		text: "规则：回复 EDITED_OK",
		isUserMessage: true,
	});
	await expect
		.poll(async () => {
			const next = await rpc<ConversationSnapshot>(page, bootstrap.token, "snapshot.get:v1", {});
			return next.conversation?.messages
				?.filter((message) => message.role === "assistant")
				.flatMap((message) => message.versions)
				.map((version) => version.content);
		})
		.toContain("EDITED_OK\n");
});
