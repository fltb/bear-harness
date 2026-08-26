import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "playwright/test";
import { startAttachmentAgentProvider } from "./attachment-agent-provider";
import { launchSourceApp, provisionReplyModel } from "./helpers";

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { kind: string; reason: string } };
type Attachment = {
	id: string;
	name: string;
	kind: "file" | "folder" | "generated";
	originEntryId?: string;
};
type Entry = { role?: string; text?: string; attachments?: Attachment[] };

async function invoke<T>(window: Page, channel: string, params: unknown): Promise<T> {
	const envelope = (await window.evaluate(
		async ({ channel, params }) => {
			return (
				window as unknown as {
					bearDesktop: {
						transport: { invoke(channel: string, params: unknown): Promise<unknown> };
					};
				}
			).bearDesktop.transport.invoke(channel, params);
		},
		{ channel, params },
	)) as Envelope<T>;
	if (!envelope.ok) throw new Error(`${channel}: ${envelope.error.kind}/${envelope.error.reason}`);
	return envelope.data;
}

async function waitForCompletedRuns(window: Page, conversationId: string, expected: number) {
	await expect
		.poll(
			async () => {
				const { runs } = await invoke<{ runs: Array<{ conversationId: string; status: string }> }>(
					window,
					"run.list:v1",
					{},
				);
				return runs.filter(
					(run) => run.conversationId === conversationId && run.status === "completed",
				).length;
			},
			{ timeout: 90_000 },
		)
		.toBe(expected);
}

test("trusted folder import uses a live grant, then its immutable snapshot after the source moves", async () => {
	test.setTimeout(180_000);
	const provider = await startAttachmentAgentProvider();
	const { app, tempRoot } = await launchSourceApp();
	const source = join(tempRoot, "real-selected-folder");
	const movedSource = join(tempRoot, "renamed-selected-folder");
	mkdirSync(join(source, "nested"), { recursive: true });
	writeFileSync(join(source, "source.txt"), "desktop source marker: quartz-71\n");
	writeFileSync(join(source, "nested", "preserved.txt"), "immutable snapshot marker\n");
	try {
		const window = await app.firstWindow();
		await provisionReplyModel(window);
		await invoke(window, "provider.customUpsert:v1", {
			providerId: "desktop-attachment-e2e",
			name: "Desktop Attachment E2E",
			baseUrl: provider.baseUrl,
			models: [{ id: "attachment-model" }],
		});
		await invoke(window, "provider.setApiKey:v1", {
			providerId: "desktop-attachment-e2e",
			apiKey: "e2e",
			sessionOnly: true,
		});
		await invoke(window, "model.enable:v1", {
			providerId: "desktop-attachment-e2e",
			modelId: "attachment-model",
			label: "Desktop Attachment E2E",
		});
		await invoke(window, "model.defaults.setReply:v1", {
			reply: { providerId: "desktop-attachment-e2e", modelId: "attachment-model" },
		});
		const conversation = await invoke<{ id: string }>(window, "conversation.create:v1", {
			title: "Attachment agent E2E",
		});
		await invoke(window, "model.route.set:v1", {
			conversationId: conversation.id,
			selected: { providerId: "desktop-attachment-e2e", modelId: "attachment-model" },
		});

		await app.evaluate(({ dialog }, selectedPath) => {
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [selectedPath],
			})) as typeof dialog.showOpenDialog;
		}, source);
		const [imported] = (await window.evaluate(async (conversationId) => {
			const desktop = (
				window as unknown as {
					bearDesktop: { attachments: { pickFolder(id: string): Promise<unknown> } };
				}
			).bearDesktop;
			return desktop.attachments.pickFolder(conversationId);
		}, conversation.id)) as Attachment[];
		if (!imported) throw new Error("folder import returned no attachment");
		expect(imported).toMatchObject({ name: "real-selected-folder", kind: "folder" });
		expect(JSON.stringify(imported)).not.toContain(source);

		const liveMarker = "E2E_DESKTOP_LIVE_RUN: delegate Pi against this selected folder.";
		await invoke(window, "message.send:v1", {
			conversationId: conversation.id,
			text: liveMarker,
			attachmentIds: [imported.id],
		});
		await waitForCompletedRuns(window, conversation.id, 1);
		expect(existsSync(join(source, "live-result.txt"))).toBe(true);
		expect(existsSync(join(source, "snapshot-result.txt"))).toBe(false);

		const firstProjection = await invoke<{ conversation?: { piTimeline: { entries: Entry[] } } }>(
			window,
			"conversation.activeGet:v1",
			{},
		);
		const firstSerialized = JSON.stringify(firstProjection);
		expect(firstSerialized).not.toContain(source);
		expect(firstSerialized).not.toMatch(/file:\/\//);
		expect(
			firstProjection.conversation?.piTimeline.entries.find(
				(entry) => entry.role === "user" && entry.text === liveMarker,
			)?.attachments,
		).toEqual([
			expect.objectContaining({ id: imported.id, name: "real-selected-folder", kind: "folder" }),
		]);
		await expect(window.getByRole("application")).not.toContainText(source);

		renameSync(source, movedSource);
		expect(existsSync(source)).toBe(false);
		const fallbackMarker =
			"E2E_DESKTOP_FALLBACK_RUN: delegate Pi again after the original source moved.";
		await invoke(window, "message.send:v1", {
			conversationId: conversation.id,
			text: fallbackMarker,
		});
		await waitForCompletedRuns(window, conversation.id, 2);
		expect(existsSync(join(movedSource, "snapshot-result.txt"))).toBe(false);
		expect(existsSync(join(movedSource, "live-result.txt"))).toBe(true);

		const attachments = (
			await invoke<{ attachments: Attachment[] }>(window, "conversationAttachment.list:v1", {
				conversationId: conversation.id,
			})
		).attachments;
		expect(attachments.filter((attachment) => attachment.kind === "generated").length).toBe(2);
		await window.reload();
		const finalProjection = await invoke<{ conversation?: { piTimeline: { entries: Entry[] } } }>(
			window,
			"conversation.activeGet:v1",
			{},
		);
		const finalSerialized = JSON.stringify(finalProjection);
		expect(finalSerialized).not.toContain(source);
		expect(finalSerialized).not.toContain(movedSource);
		expect(finalSerialized).not.toMatch(/file:\/\//);
		expect(
			finalProjection.conversation?.piTimeline.entries
				.flatMap((entry) => entry.attachments ?? [])
				.filter((attachment) => attachment.kind === "generated").length,
		).toBe(2);
		expect(provider.calls.filter((call) => call.tool === "host_delegate_agent")).toHaveLength(2);
		expect(provider.calls.filter((call) => call.tool === "bash")).toHaveLength(2);
	} finally {
		await app.close().catch(() => undefined);
		await provider.close().catch(() => undefined);
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
