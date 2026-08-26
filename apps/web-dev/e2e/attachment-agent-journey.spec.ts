import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Page, test } from "playwright/test";
import { ensureReadyForConversation, getBootstrap, sendMessage } from "./helpers";

const singleFile = fileURLToPath(new URL("./fixtures/single-note.txt", import.meta.url));
const folder = fileURLToPath(new URL("./fixtures/web-folder", import.meta.url));
const providerOrigin = `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}`;
type Envelope<T> = { ok: true; data: T } | { ok: false; error: { kind: string; reason: string } };
type Attachment = {
	id: string;
	name: string;
	kind: "file" | "folder" | "generated";
	originEntryId?: string;
};
type Entry = { kind: string; role?: string; text?: string; attachments?: Attachment[] };

async function rpc<T>(
	page: Page,
	token: string,
	channel: string,
	params: unknown,
): Promise<Envelope<T>> {
	const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
		headers: { "x-bear-web-dev-token": token },
		data: params,
	});
	expect(response.status()).toBe(200);
	return response.json() as Promise<Envelope<T>>;
}
function ok<T>(value: Envelope<T>): T {
	if (!value.ok) throw new Error(`${value.error.kind}/${value.error.reason}`);
	return value.data;
}
async function active(page: Page, token: string) {
	const value = ok(
		await rpc<{ conversation?: { id: string; piTimeline: { entries: Entry[] } } }>(
			page,
			token,
			"conversation.activeGet:v1",
			{},
		),
	).conversation;
	if (!value) throw new Error("missing active conversation");
	return value;
}

test("file and folder attachments survive delegation, reload, download, and remain conversation-scoped", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await ensureReadyForConversation(page);
	const { token } = await getBootstrap(page);
	const first = await active(page, token);
	await page.getByLabel(zhCN.composer.uploadFile, { exact: true }).setInputFiles(singleFile);
	await page.getByLabel(zhCN.composer.uploadFolder, { exact: true }).setInputFiles(folder);
	await expect(page.getByText("single-note.txt", { exact: true })).toBeVisible();
	await expect(page.getByText("web-folder", { exact: true })).toBeVisible();

	const marker =
		"E2E_WEB_ATTACHMENT_AGENT_JOURNEY: list and read both attachments, then delegate a generated report to Pi.";
	const sent = page.waitForRequest((request) => request.url().includes("/rpc/message.send%3Av1"));
	await sendMessage(page, marker);
	const body = (await sent).postDataJSON() as {
		conversationId: string;
		text: string;
		attachmentIds: string[];
	};
	expect(body).toEqual({
		conversationId: first.id,
		text: marker,
		attachmentIds: [expect.any(String), expect.any(String)],
	});
	expect(JSON.stringify(body)).not.toMatch(/glacier-17|aurora-29|base64/);

	await expect
		.poll(
			async () =>
				(await active(page, token)).piTimeline.entries.find(
					(entry) => entry.role === "user" && entry.text === marker,
				)?.attachments,
		)
		.toEqual([
			expect.objectContaining({ id: body.attachmentIds[0], name: "single-note.txt", kind: "file" }),
			expect.objectContaining({ id: body.attachmentIds[1], name: "web-folder", kind: "folder" }),
		]);
	let terminalStatus: string | undefined;
	await expect
		.poll(
			async () => {
				terminalStatus = ok(
					await rpc<{ runs: Array<{ conversationId: string; status: string }> }>(
						page,
						token,
						"run.list:v1",
						{},
					),
				).runs.find((run) => run.conversationId === first.id)?.status;
				return terminalStatus === "completed" || terminalStatus === "failed";
			},
			{ timeout: 90_000 },
		)
		.toBe(true);
	const trace = (await (await page.request.get(`${providerOrigin}/trace/tools`)).json()) as {
		calls: Array<{ tool: string; args: Record<string, unknown> }>;
	};
	expect(terminalStatus, JSON.stringify(trace.calls)).toBe("completed");
	const calls = trace.calls.filter((call) => call.tool.startsWith("host_")).slice(-4);
	expect(calls.map((call) => call.tool)).toEqual([
		"host_list_attachments",
		"host_read_attachment",
		"host_read_attachment",
		"host_delegate_agent",
	]);
	expect(calls[3]?.args).toMatchObject({
		agent: "pi",
		attachmentIds: body.attachmentIds,
		workspaceAttachmentId: body.attachmentIds[1],
	});

	const listed = ok(
		await rpc<{ attachments: Attachment[] }>(page, token, "conversationAttachment.list:v1", {
			conversationId: first.id,
		}),
	).attachments;
	const generated = listed.find((attachment) => attachment.kind === "generated");
	if (!generated) throw new Error("missing generated assistant attachment");
	await expect
		.poll(async () =>
			(await active(page, token)).piTimeline.entries.some(
				(entry) =>
					entry.role === "assistant" && entry.attachments?.some((item) => item.id === generated.id),
			),
		)
		.toBe(true);
	await page.reload();
	await expect(page.getByText(generated.name, { exact: true })).toBeVisible();
	const reloadedIds = (await active(page, token)).piTimeline.entries
		.flatMap((entry) => entry.attachments ?? [])
		.map((item) => item.id);
	expect(reloadedIds).toEqual(expect.arrayContaining([...body.attachmentIds, generated.id]));

	const read = ok(
		await rpc<{ files?: Array<{ relativePath: string }>; content?: string }>(
			page,
			token,
			"conversationAttachment.read:v1",
			{ mode: "semantic", conversationId: first.id, attachmentId: generated.id },
		),
	);
	const relativePath = read.files?.find((file) =>
		file.relativePath.endsWith("generated-report.txt"),
	)?.relativePath;
	const url = ok(
		await rpc<{ url: string }>(page, token, "conversationAttachment.url:v1", {
			conversationId: first.id,
			attachmentId: generated.id,
			...(relativePath ? { relativePath } : {}),
			operation: "download",
		}),
	).url;
	expect(url).not.toMatch(/file:\/\/|attachment-uploads/);
	const download = await page.request.get(url);
	await expect(download).toBeOK();
	expect(await download.text()).toBe("generated from immutable web attachments\n");

	const nav = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const count = await nav.getByRole("button").count();
	await page.getByRole("button", { name: zhCN.sidebar.newConversation }).click();
	await expect.poll(() => nav.getByRole("button").count()).toBeGreaterThan(count);
	const second = await active(page, token);
	expect(second.id).not.toBe(first.id);
	expect(
		ok(
			await rpc<{ attachments: Attachment[] }>(page, token, "conversationAttachment.list:v1", {
				conversationId: second.id,
			}),
		).attachments,
	).toEqual([]);
	for (const [channel, params] of [
		["conversationAttachment.list:v1", { conversationId: second.id, attachmentId: generated.id }],
		[
			"conversationAttachment.read:v1",
			{ mode: "semantic", conversationId: second.id, attachmentId: generated.id },
		],
		[
			"conversationAttachment.url:v1",
			{ conversationId: second.id, attachmentId: generated.id, operation: "download" },
		],
	] as const)
		expect(await rpc(page, token, channel, params)).toMatchObject({
			ok: false,
			error: { kind: "not_found" },
		});
});
