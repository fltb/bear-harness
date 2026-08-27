import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
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
type Entry = { id?: string; role?: string; text?: string; attachments?: Attachment[] };

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

async function waitForCompletedRun(window: Page, conversationId: string, triggerEntryId: string) {
	type Run = { id: string; conversationId: string; triggerEntryId: string; status: string };
	type AuditEntry = { seq: number; action: string; detail: string };
	let terminalRun: Run | undefined;
	await expect
		.poll(
			async () => {
				const { runs } = await invoke<{ runs: Run[] }>(window, "run.list:v1", {});
				terminalRun = runs.find(
					(run) =>
						run.conversationId === conversationId &&
						run.triggerEntryId === triggerEntryId &&
						["completed", "failed", "cancelled", "interrupted", "forced_termination"].includes(
							run.status,
						),
				);
				return terminalRun !== undefined;
			},
			{ timeout: 90_000 },
		)
		.toBe(true);
	if (terminalRun?.status === "completed") return terminalRun;

	let relatedAudit: AuditEntry[] = [];
	await expect
		.poll(
			async () => {
				const audit = await invoke<{ entries: AuditEntry[] }>(window, "audit.list:v1", {
					limit: 500,
				});
				relatedAudit = audit.entries.filter(
					(entry) =>
						entry.detail.includes(terminalRun?.id ?? "") || entry.detail.includes(conversationId),
				);
				return relatedAudit.length > 0;
			},
			{ timeout: 5_000 },
		)
		.toBe(true)
		.catch(() => undefined);
	throw new Error(
		`external attachment run terminated unsuccessfully: ${JSON.stringify({
			run: terminalRun,
			audit: relatedAudit.map(({ seq, action, detail }) => ({ seq, action, detail })),
		})}`,
	);
}

test("folder import delegates only its immutable snapshot after the source moves", async () => {
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
		renameSync(source, movedSource);
		expect(existsSync(source)).toBe(false);

		writeFileSync(
			join(movedSource, "source.txt"),
			"moved live source marker: altered-after-upload\n",
		);
		writeFileSync(
			join(movedSource, "nested", "preserved.txt"),
			"moved live nested marker: altered-after-upload\n",
		);
		expect(readFileSync(join(movedSource, "source.txt"), "utf8")).toBe(
			"moved live source marker: altered-after-upload\n",
		);

		const snapshotMarker =
			"E2E_DESKTOP_SNAPSHOT_RUN: delegate Pi against the immutable selected-folder snapshot.";
		const sent = await invoke<{ entryId: string }>(window, "message.send:v1", {
			conversationId: conversation.id,
			text: snapshotMarker,
			attachmentIds: [imported.id],
		});
		const completedRun = await waitForCompletedRun(window, conversation.id, sent.entryId);

		expect(existsSync(source)).toBe(false);
		expect(existsSync(join(movedSource, "confinement-escape.txt"))).toBe(false);
		expect(existsSync(join(movedSource, "snapshot-report.txt"))).toBe(false);
		expect(readFileSync(join(movedSource, "source.txt"), "utf8")).toBe(
			"moved live source marker: altered-after-upload\n",
		);
		expect(readFileSync(join(movedSource, "nested", "preserved.txt"), "utf8")).toBe(
			"moved live nested marker: altered-after-upload\n",
		);

		const firstProjection = await invoke<{ conversation?: { piTimeline: { entries: Entry[] } } }>(
			window,
			"conversation.activeGet:v1",
			{},
		);
		const firstSerialized = JSON.stringify(firstProjection);
		expect(firstSerialized).not.toContain(source);
		expect(firstSerialized).not.toContain(movedSource);
		expect(firstSerialized).not.toMatch(/file:\/\//);
		expect(
			firstProjection.conversation?.piTimeline.entries.find(
				(entry) => entry.role === "user" && entry.text === snapshotMarker,
			)?.attachments,
		).toEqual([
			expect.objectContaining({ id: imported.id, name: "real-selected-folder", kind: "folder" }),
		]);
		await expect(window.getByRole("application")).not.toContainText(source);
		await expect(window.getByRole("application")).not.toContainText(movedSource);

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
		const entries = finalProjection.conversation?.piTimeline.entries ?? [];
		const triggerIndex = entries.findIndex((entry) => entry.id === completedRun.triggerEntryId);
		const generatedAttachments =
			triggerIndex < 0
				? []
				: entries
						.slice(triggerIndex + 1)
						.flatMap((entry) => entry.attachments ?? [])
						.filter((attachment) => attachment.kind === "generated");
		if (triggerIndex < 0 || generatedAttachments.length !== 1) {
			throw new Error(
				`completed run output projection lookup failed: ${JSON.stringify({
					run: completedRun,
					triggerIndex,
					entries,
				})}`,
			);
		}
		const generated = generatedAttachments[0]!;
		const exactAttachment = await invoke<{ attachments: Attachment[] }>(
			window,
			"conversationAttachment.list:v1",
			{ conversationId: conversation.id, attachmentId: generated.id },
		);
		expect(exactAttachment.attachments).toEqual([generated]);

		const files = await invoke<{
			files?: Array<{ relativePath: string; entryKind: string; readable: boolean }>;
			content?: string;
			error?: string;
		}>(window, "conversationAttachment.read:v1", {
			mode: "semantic",
			conversationId: conversation.id,
			attachmentId: generated.id,
		});
		const [reportFile, ...unexpectedFiles] = files.files ?? [];
		if (
			!reportFile ||
			unexpectedFiles.length !== 0 ||
			reportFile.relativePath !== "snapshot-report.txt" ||
			reportFile.entryKind !== "file" ||
			!reportFile.readable
		) {
			throw new Error(
				`generated snapshot report lookup failed: ${JSON.stringify({
					run: completedRun,
					attachment: generated,
					listing: files,
				})}`,
			);
		}
		const reportPath = reportFile.relativePath;
		const report = await invoke<{ content?: string }>(window, "conversationAttachment.read:v1", {
			mode: "semantic",
			conversationId: conversation.id,
			attachmentId: generated.id,
			relativePath: reportPath,
		});
		expect(report.content).toContain("generated from immutable desktop snapshot\n");
		expect(report.content).toContain("desktop source marker: quartz-71\n");
		expect(report.content).toContain("immutable snapshot marker\n");
		expect(report.content).toContain("workspace_write_denied=true\n");
		const workspacePath = report.content?.match(/^workspace=(.+)$/m)?.[1];
		const outputPath = report.content?.match(/^output=(.+)$/m)?.[1];
		expect(workspacePath && isAbsolute(workspacePath)).toBe(true);
		expect(outputPath && isAbsolute(outputPath)).toBe(true);
		expect(workspacePath?.endsWith(join("snapshot-0", "inputs", imported.id))).toBe(true);
		expect(basename(outputPath ?? "")).toBe("outputs");
		expect(workspacePath).not.toBe(outputPath);
		expect(workspacePath).not.toContain(source);
		expect(workspacePath).not.toContain(movedSource);
		expect(outputPath).not.toContain(source);
		expect(outputPath).not.toContain(movedSource);
		expect(report.content).toBe(
			`generated from immutable desktop snapshot\nworkspace=${workspacePath}\noutput=${outputPath}\nworkspace_write_denied=true\ndesktop source marker: quartz-71\nimmutable snapshot marker\n`,
		);

		expect(provider.calls.filter((call) => call.tool === "host_delegate")).toHaveLength(1);
		expect(provider.calls.filter((call) => call.tool === "bash")).toHaveLength(1);
	} finally {
		await app.close().catch(() => undefined);
		await provider.close().catch(() => undefined);
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
