import { zhCN } from "@bear-harness/i18n/locales";
import type { CharacterMedia } from "@bear-harness/protocol";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MediaViewer } from "../src/ConversationPanel.js";

const imageMedia: CharacterMedia = {
	id: "portrait",
	kind: "image",
	label: "极昼的来处",
	description: "一束落在旧书页上的灯光。",
	use_when: "当对话自然谈到来处时展示。",
	loop: false,
	url: "data:image/png;base64,aW1hZ2U=",
};

describe("motion system contracts", () => {
	it("separates media expansion from Kobalte open state and waits for exit completion", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(() => <MediaViewer media={imageMedia} onClose={onClose} />);

		const viewer = screen.getByRole("dialog", { name: imageMedia.label });
		expect(viewer).toHaveAttribute("data-expanded");
		expect(viewer).toHaveAttribute("data-bear-media-expanded", "false");

		await user.click(screen.getByRole("button", { name: zhCN.messages.expandMedia }));
		expect(viewer).toHaveAttribute("data-expanded");
		expect(viewer).toHaveAttribute("data-bear-media-expanded", "true");

		await user.click(screen.getByRole("button", { name: zhCN.messages.closeMedia }));
		expect(onClose).not.toHaveBeenCalled();
		expect(viewer).toHaveAttribute("data-closed");
		fireEvent.animationEnd(viewer);
		expect(onClose).toHaveBeenCalledOnce();
	});
});
