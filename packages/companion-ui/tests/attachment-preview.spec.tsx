import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	AttachmentPreviewProvider,
	useAttachmentPreview,
} from "../src/features/AttachmentPreviewPanel.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";

const textAttachment = {
	id: "attachment-text",
	name: "notes.txt",
	kind: "file" as const,
	bytes: 28,
	fileCount: 1,
	originEntryId: "entry-1",
};
const folderAttachment = {
	id: "attachment-folder",
	name: "research",
	kind: "folder" as const,
	bytes: 12,
	fileCount: 2,
	originEntryId: "entry-1",
};

function PreviewTrigger(props: { attachment: typeof textAttachment | typeof folderAttachment }) {
	const preview = useAttachmentPreview();
	return (
		<button type="button" onClick={() => void preview?.open(props.attachment)}>
			Open {props.attachment.name}
		</button>
	);
}

function renderPreview(
	attachment: typeof textAttachment | typeof folderAttachment,
	attachments: Pick<CompanionStore["attachments"], "read" | "url">,
) {
	const store = {
		activeConversationId: "conversation-1",
		attachments,
	} as unknown as CompanionStore;
	return render(() => (
		<DesktopProvider store={store}>
			<AttachmentPreviewProvider>
				<PreviewTrigger attachment={attachment} />
			</AttachmentPreviewProvider>
		</DesktopProvider>
	));
}

describe("attachment preview", () => {
	it("renders semantic text as inert text and reads it in semantic mode", async () => {
		const content = `<img src="bad" onerror="globalThis.compromised=true">`;
		const read = vi.fn(() => Promise.resolve({ mode: "semantic" as const, content }));
		const url = vi.fn(() => Promise.resolve("bear-attachment://cap/download/token"));
		renderPreview(textAttachment, { read, url });

		await userEvent.setup().click(screen.getByRole("button", { name: "Open notes.txt" }));

		const contentElement = await screen.findByText(content);
		expect(contentElement).toBeVisible();
		const preview = screen.getByRole("complementary", { name: zhCN.attachments.previewLabel });
		expect(within(preview).queryByRole("img")).not.toBeInTheDocument();
		expect(read).toHaveBeenCalledWith({
			conversationId: "conversation-1",
			attachmentId: "attachment-text",
			mode: "semantic",
		});
	});

	it("opens regular folder files and downloads the exact selected entry name", async () => {
		const read = vi.fn((params: { relativePath?: string }) =>
			Promise.resolve(
				params.relativePath
					? { mode: "semantic" as const, content: "selected file" }
					: {
							mode: "semantic" as const,
							files: [
								{
									relativePath: "chapter",
									entryKind: "directory" as const,
									readable: false,
								},
								{
									relativePath: "chapter/notes.txt",
									entryKind: "file" as const,
									mime: "text/plain",
									bytes: 12,
									readable: true,
								},
							],
						},
			),
		);
		const url = vi.fn(() => Promise.resolve("bear-attachment://cap/download/token"));
		let downloadedName = "";
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			downloadedName = this.download;
		});
		renderPreview(folderAttachment, { read, url });
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "Open research" }));
		const directory = await screen.findByRole("button", { name: /chapter文件夹/u });
		expect(directory).toBeDisabled();
		await user.click(screen.getByRole("button", { name: /chapter\/notes\.txt文件/u }));
		expect(await screen.findByText("selected file")).toBeVisible();
		expect(read).toHaveBeenLastCalledWith({
			conversationId: "conversation-1",
			attachmentId: "attachment-folder",
			relativePath: "chapter/notes.txt",
			mode: "semantic",
		});

		await user.click(screen.getByRole("button", { name: zhCN.attachments.download }));
		await waitFor(() =>
			expect(url).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				attachmentId: "attachment-folder",
				relativePath: "chapter/notes.txt",
				operation: "download",
			}),
		);
		expect(downloadedName).toBe("notes.txt");
		click.mockRestore();
	});

	it.each([
		["image", "photo.png", zhCN.attachments.imagePreview],
		["audio", "voice.mp3", zhCN.attachments.audioPreview],
		["video", "clip.mp4", zhCN.attachments.videoPreview],
		["PDF", "brief.pdf", zhCN.attachments.pdfPreview],
	] as const)(
		"previews allowlisted %s files with a Host capability URL",
		async (kind, name, labelTemplate) => {
			const attachment = { ...textAttachment, id: `attachment-${name}`, name };
			const read = vi.fn(() => Promise.resolve({ mode: "semantic" as const, content: "not used" }));
			const url = vi.fn(() => Promise.resolve(`bear-attachment://cap/preview/${name}`));
			renderPreview(attachment, { read, url });

			await userEvent.setup().click(screen.getByRole("button", { name: `Open ${name}` }));
			const label = labelTemplate.replace("{name}", name);
			const media =
				kind === "image"
					? await screen.findByRole("img", { name: label })
					: await screen.findByLabelText(label);
			expect(media).toBeInTheDocument();
			expect(url).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				attachmentId: `attachment-${name}`,
				operation: "preview",
			});
			expect(read).not.toHaveBeenCalled();
		},
	);

	it("keeps download available when preview capability minting fails", async () => {
		const attachment = { ...textAttachment, id: "attachment-video", name: "clip.mp4" };
		const read = vi.fn(() => Promise.resolve({ mode: "semantic" as const }));
		const url = vi.fn(() => Promise.reject(new Error("capability unavailable")));
		renderPreview(attachment, { read, url });

		await userEvent.setup().click(screen.getByRole("button", { name: "Open clip.mp4" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(zhCN.attachments.previewUnavailable);
		expect(screen.getByRole("button", { name: zhCN.attachments.download })).toBeEnabled();
	});

	it("shows metadata and download for an unknown file type without rendering binary content", async () => {
		const attachment = { ...textAttachment, id: "attachment-archive", name: "archive.zip" };
		const read = vi.fn(() => Promise.resolve({ mode: "semantic" as const, content: "binary" }));
		const url = vi.fn(() => Promise.resolve("bear-attachment://cap/download/archive"));
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => undefined);
		renderPreview(attachment, { read, url });
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "Open archive.zip" }));

		const metadata = screen.getByText(zhCN.attachments.nameLabel).closest("dl");
		expect(metadata).toHaveAttribute("aria-label", zhCN.attachments.metadataLabel);
		expect(metadata).toHaveTextContent("archive.zip");
		expect(read).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: zhCN.attachments.download }));
		await waitFor(() =>
			expect(url).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				attachmentId: "attachment-archive",
				operation: "download",
			}),
		);
		click.mockRestore();
	});

	it("revokes a blob preview URL when the accessible close action dismisses the panel", async () => {
		const attachment = { ...textAttachment, id: "attachment-image", name: "photo.png" };
		const read = vi.fn(() => Promise.resolve({ mode: "semantic" as const }));
		const url = vi.fn(() => Promise.resolve("blob:attachment-preview"));
		const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
		renderPreview(attachment, { read, url });
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "Open photo.png" }));
		expect(await screen.findByRole("img", { name: /photo\.png/u })).toBeVisible();
		await user.click(screen.getByRole("button", { name: zhCN.attachments.close }));

		expect(revoke).toHaveBeenCalledWith("blob:attachment-preview");
		expect(
			screen.queryByRole("complementary", { name: zhCN.attachments.previewLabel }),
		).not.toBeInTheDocument();
		revoke.mockRestore();
	});
});
