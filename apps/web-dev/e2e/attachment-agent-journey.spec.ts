import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Locator, type Page, test } from "playwright/test";
import { ensureReadyForConversation, getBootstrap, sendMessage } from "./helpers";

const singleFile = fileURLToPath(new URL("./fixtures/single-note.txt", import.meta.url));
const folder = fileURLToPath(new URL("./fixtures/web-folder", import.meta.url));
const providerOrigin = `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}`;
const screenshotDir = resolve(import.meta.dirname, "../../../artifacts/ux-coverage-2026-08-28");
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

async function stableBoundingBox(locator: Locator) {
	let box = await locator.boundingBox();
	await expect
		.poll(async () => {
			box = await locator.boundingBox();
			return box;
		})
		.not.toBeNull();
	if (box === null) throw new Error("visible element did not produce a stable bounding box");
	return box;
}

test("file and folder attachments survive delegation, reload, download, and remain conversation-scoped", async ({
	page,
}) => {
	test.setTimeout(120_000);
	mkdirSync(screenshotDir, { recursive: true });
	await ensureReadyForConversation(page);
	const { token } = await getBootstrap(page);
	const first = await active(page, token);
	await page.getByLabel(zhCN.composer.uploadFile, { exact: true }).setInputFiles(singleFile);
	await page.getByLabel(zhCN.composer.uploadFolder, { exact: true }).setInputFiles(folder);
	await expect(page.getByText("single-note.txt", { exact: true })).toBeVisible();
	await expect(page.getByText("web-folder", { exact: true })).toBeVisible();
	await page.screenshot({
		path: resolve(screenshotDir, "20-pi-attachments-ready.png"),
		fullPage: true,
	});

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
	const promptTrace = (await (
		await page.request.get(`${providerOrigin}/trace/prompts`)
	).json()) as {
		prompts: string[];
	};
	const externalResultPrompt = promptTrace.prompts.findLast((prompt) =>
		prompt.includes("An external agent run has finished."),
	);
	expect(
		terminalStatus,
		JSON.stringify({
			calls: trace.calls,
			externalResultPrompt:
				externalResultPrompt?.slice(-6_000) ?? "missing external-agent result prompt",
		}),
	).toBe("completed");

	const triggerCard = page
		.getByRole("article", { name: zhCN.messages.you })
		.filter({ hasText: marker });
	const resultMessageRow = page.locator(".timeline-entry-row").filter({
		has: page.locator('.timeline-attachment-row[data-attachment-kind="generated"]'),
	});
	const resultMessage = resultMessageRow.locator("article.pi-timeline-message");
	const resultTrigger = resultMessageRow.locator(".agent-result-trigger");
	const resultPanel = page.locator(".agent-result-panel");
	await expect(triggerCard).toBeVisible();
	await expect(resultMessage).toBeVisible();
	await expect(resultTrigger).toBeVisible();
	await expect(resultPanel).toBeVisible();
	await expect(resultPanel.getByRole("button", { name: "Generated outputs" })).toBeVisible();
	const warning = page.getByRole("status").filter({ hasText: zhCN.language.warningTitle });
	await expect(warning).toBeVisible();
	expect(
		Number(await warning.evaluate((element) => getComputedStyle(element).zIndex)),
	).toBeGreaterThan(70);
	await warning.getByRole("button", { name: zhCN.language.dismiss }).click();
	await expect(warning).toBeHidden();

	for (const viewport of [
		{ mode: "window", width: 1280, height: 800 },
		{ mode: "fullscreen", width: 1920, height: 1080 },
	] as const) {
		await page.setViewportSize(viewport);
		const application = page.getByRole("application", { name: zhCN.shell.productName });
		await expect(application).toHaveAttribute("data-layout", viewport.mode);
		await expect(triggerCard).toBeVisible();
		await expect(resultMessage).toBeVisible();
		await expect(resultPanel).toBeVisible();
		await application.screenshot({
			path: resolve(screenshotDir, `21-conversation-work-cards-${viewport.mode}.png`),
		});
		const [mainBox, threadBox, composerBox, resultMessageBox, resultBox, presenceBox] =
			await Promise.all([
				stableBoundingBox(page.locator("main.main")),
				stableBoundingBox(page.getByRole("region", { name: zhCN.messages.conversation })),
				stableBoundingBox(page.getByRole("form", { name: zhCN.composer.messageInputLabel })),
				stableBoundingBox(resultMessage),
				stableBoundingBox(resultPanel),
				stableBoundingBox(page.getByTestId("presence-asset")),
			]);
		expect(Math.abs((threadBox?.x ?? 0) - (composerBox?.x ?? 0))).toBeLessThanOrEqual(1);
		expect(Math.abs((threadBox?.width ?? 0) - (composerBox?.width ?? 0))).toBeLessThanOrEqual(1);
		expect(resultBox.x).toBeGreaterThanOrEqual(threadBox.x + threadBox.width);
		expect(resultBox.y - mainBox.y).toBeLessThanOrEqual(20);
		expect(mainBox.y + mainBox.height - (resultBox.y + resultBox.height)).toBeLessThanOrEqual(20);
		expect(resultBox.height).toBeGreaterThan(mainBox.height - 40);
		expect(resultMessageBox.x).toBeGreaterThanOrEqual(threadBox.x + 40);
		expect(presenceBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThan(
			(resultBox?.width ?? 0) * 0.6,
		);
		expect(
			await page
				.getByTestId("presence-asset")
				.evaluate((element) =>
					element.parentElement ? getComputedStyle(element.parentElement).opacity : "detached",
				),
		).toBe("1");
		expect(
			await page
				.getByRole("region", { name: zhCN.messages.conversation })
				.evaluate((element) => getComputedStyle(element).backgroundImage),
		).toBe("none");
		await resultPanel.getByRole("button", { name: zhCN.work.result.close }).click();
		await expect(resultPanel).toBeHidden();
		const expandedThreadBox = await stableBoundingBox(
			page.getByRole("region", { name: zhCN.messages.conversation }),
		);
		expect(expandedThreadBox.width).toBeGreaterThan(threadBox.width);
		await resultTrigger.click();
		await expect(resultPanel).toBeVisible();
	}

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByRole("application", { name: zhCN.shell.productName })).toHaveAttribute(
		"data-layout",
		"mobile",
	);
	await expect(resultPanel).toBeHidden();
	await expect(resultTrigger).toBeHidden();
	const inlineResult = resultMessageRow.locator(".agent-result-inline-card");
	await expect(inlineResult).toBeVisible();
	await inlineResult.scrollIntoViewIfNeeded();
	const [mobileMessageBox, mobileResultBox, mobileThreadBox, mobileComposerBox, mobileAppBox] =
		await Promise.all([
			stableBoundingBox(resultMessage),
			stableBoundingBox(inlineResult),
			stableBoundingBox(page.getByRole("region", { name: zhCN.messages.conversation })),
			stableBoundingBox(page.getByRole("form", { name: zhCN.composer.messageInputLabel })),
			stableBoundingBox(page.getByRole("application", { name: zhCN.shell.productName })),
		]);
	expect(mobileResultBox.y).toBeGreaterThanOrEqual(mobileMessageBox.y + mobileMessageBox.height);
	expect(mobileResultBox.x).toBeGreaterThanOrEqual(mobileThreadBox.x);
	expect(mobileResultBox.x + mobileResultBox.width).toBeLessThanOrEqual(
		mobileThreadBox.x + mobileThreadBox.width,
	);
	expect(mobileResultBox.y + mobileResultBox.height).toBeLessThanOrEqual(
		mobileThreadBox.y + mobileThreadBox.height + 1,
	);
	expect(mobileComposerBox.y).toBeGreaterThanOrEqual(mobileThreadBox.y + mobileThreadBox.height);
	expect(mobileComposerBox.y + mobileComposerBox.height).toBeLessThanOrEqual(
		mobileAppBox.y + mobileAppBox.height,
	);
	expect(mobileAppBox.height).toBeLessThanOrEqual(844);
	expect(mobileComposerBox.y + mobileComposerBox.height).toBeLessThanOrEqual(844);
	const mobileNavigation = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	await expect
		.poll(async () => {
			const box = await mobileNavigation.boundingBox();
			return (box?.x ?? 0) + (box?.width ?? 0);
		})
		.toBeLessThanOrEqual(0);
	await page.screenshot({
		path: resolve(screenshotDir, "21-conversation-work-cards-mobile.png"),
	});
	await page.setViewportSize({ width: 1280, height: 800 });

	const calls = trace.calls.filter((call) => call.tool.startsWith("host_")).slice(-4);
	expect(calls.map((call) => call.tool)).toEqual([
		"host_attachment",
		"host_attachment",
		"host_attachment",
		"host_delegate",
	]);
	expect(calls[3]?.args).toMatchObject({
		agent: "pi",
		attachmentIds: body.attachmentIds,
		workspaceAttachmentId: body.attachmentIds[1],
	});
	await page.screenshot({
		path: resolve(screenshotDir, "21-pi-delegation-complete.png"),
		fullPage: true,
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
	await expect(
		page.locator(".agent-result-panel").getByRole("button", { name: generated.name, exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: resolve(screenshotDir, "22-pi-result-after-reload.png"),
		fullPage: true,
	});
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
