import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DraftAsset } from "../src/features/studio/DraftPreview.js";
import type { CharacterApi } from "../src/stores/supplementary-api.js";

const revoke = vi.fn();
const blobs: Blob[] = [];
beforeEach(() => {
	blobs.length = 0;
	revoke.mockClear();
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL(blob: Blob) {
				blobs.push(blob);
				return `blob:${blobs.length}`;
			}
			static revokeObjectURL(url: string) {
				revoke(url);
			}
		},
	);
});
afterEach(() => vi.unstubAllGlobals());
it.each([
	["clip.mp4", "VIDEO", "video/mp4"],
	["clip.webm", "VIDEO", "video/webm"],
	["clip.mp3", "AUDIO", "audio/mpeg"],
])(
	"previews %s with native controls and captions, then releases its resources",
	async (path, tag, mime) => {
		const draftFile = vi.fn(async () =>
			new TextEncoder().encode("WEBVTT\n\n00:00.000 --> 00:01.000\nText"),
		);
		const api = { draftFile } as unknown as CharacterApi;
		const view = render(() => <DraftAsset api={api} id="draft" path={path!} captions="clip.vtt" />);
		const media = await screen.findByLabelText(path!);
		expect(media.tagName).toBe(tag);
		expect(media).toHaveAttribute("controls");
		expect(draftFile).toHaveBeenCalledWith("draft", "clip.vtt", undefined);
		await waitFor(() => expect(blobs.map((blob) => blob.type)).toContain("text/vtt"));
		expect(blobs.map((blob) => blob.type)).toContain(mime);
		view.unmount();
		expect(revoke).toHaveBeenCalledTimes(2);
	},
);
it("renders text as sanitized Markdown and reports a missing file without breaking the editor", async () => {
	const draftFile = vi.fn(async () =>
		new TextEncoder().encode("# Reference\n<script>alert(1)</script>"),
	);
	const api = { draftFile } as unknown as CharacterApi;
	const markdown = render(() => <DraftAsset api={api} id="draft" path="canon/reference.md" />);
	await screen.findByRole("heading", { name: "Reference" });
	expect(screen.queryByText("alert(1)")).toBeNull();
	markdown.unmount();
	draftFile.mockRejectedValueOnce(new Error("Missing file"));
	render(() => <DraftAsset api={api} id="draft" path="assets/missing.png" />);
	await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Missing file"));
	expect(screen.queryByText(zhCN.studio.originalPreview)).toBeNull();
});
