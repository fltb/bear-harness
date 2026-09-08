import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import type { CharacterMedia } from "@bear-harness/protocol";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MediaViewer } from "../src/ConversationPanel.js";

const readStyle = (name: string) => readFileSync(resolve(process.cwd(), "src", name), "utf8");
const motionStyles = () => readStyle("styles/motion.css");
const styleEntry = () => readStyle("styles.css");
const layoutStyles = () => readStyle("styles/layout.css");
const visualStyles = () => readStyle("styles/visuals.css");

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
	it("publishes reusable duration, easing, distance, and scale tokens", () => {
		expect(styleEntry()).toContain('@import "./styles/motion.css";');
		const css = motionStyles();
		for (const token of [
			"--motion-duration-micro",
			"--motion-duration-surface-exit",
			"--motion-duration-surface",
			"--motion-duration-scene",
			"--motion-ease-standard",
			"--motion-ease-enter",
			"--motion-ease-exit",
			"--motion-distance-micro",
			"--motion-distance-small",
			"--motion-distance-panel",
			"--motion-scale-enter",
		]) {
			expect(css).toContain(token);
		}
		for (const primitive of [
			".motion-modal",
			".motion-drawer-inline",
			".motion-drawer-block",
			".motion-timeline-entry",
			".motion-presence-change",
			".motion-activity",
		]) {
			expect(css).toContain(primitive);
		}
		expect(layoutStyles()).toContain("prefers-reduced-motion: reduce");
	});

	it("keeps navigation and presence motion on compositor-friendly properties", () => {
		const sidebarRule = layoutStyles()
			.split('.app[data-layout="mobile"] .sidebar {')[1]
			?.split("}")[0];
		expect(sidebarRule).toBeDefined();
		expect(sidebarRule).not.toContain("visibility: hidden");

		const presenceRule = visualStyles().split(".presence-stage {")[1]?.split("}")[0];
		expect(presenceRule).toBeDefined();
		expect(presenceRule).not.toContain("block-size");
		expect(presenceRule).not.toContain("inline-size");
		expect(presenceRule).not.toContain("filter");
	});

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
