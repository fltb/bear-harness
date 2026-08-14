import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/renderer/App";
import { OFFICIAL_PRODUCT } from "../fixtures";

describe("idle homepage (official config)", () => {
	it("renders app title, character identity and the composer", () => {
		render(() => <App product={OFFICIAL_PRODUCT} />);

		expect(document.title).toBe("Cyber Bear");
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("极光书房 · 雪停以后");
		expect(screen.getByText("极昼")).toBeInTheDocument();
		expect(screen.getByText("旧极光站的守望者")).toBeInTheDocument();
		expect(
			screen.getByText("你回来了。今晚是想说会儿话，还是有东西要我替你看着？"),
		).toBeInTheDocument();
		// Composer is live but inert until a conversation is active (no bridge in tests)
		expect(screen.getByPlaceholderText("对极昼说点什么…")).toBeInTheDocument();
	});

	it("keeps the shell around brand identity and accessibility landmarks", () => {
		render(() => <App product={OFFICIAL_PRODUCT} />);

		// Brand identity
		expect(screen.getByRole("navigation", { name: "对话" })).toBeInTheDocument();
		// Search stays static (not on the bridge yet)
		expect(screen.getByRole("button", { name: /搜索/ })).toBeDisabled();
		// System navs stay static (not on the bridge yet)
		expect(screen.getByRole("button", { name: "关系档案" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "系统设置" })).toBeDisabled();
	});

	it("opens the backstage sheet from the titlebar", async () => {
		const user = userEvent.setup();
		render(() => <App product={OFFICIAL_PRODUCT} />);

		const backstage = screen.getByRole("button", { name: "幕后" });
		expect(backstage).toBeEnabled();
		await user.click(backstage);
		// Dialog opens with the three backstage tabs
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "关系档案" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "记忆" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "系统设置" })).toBeInTheDocument();
	});
});