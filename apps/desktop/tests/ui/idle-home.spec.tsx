import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/renderer/App";
import { OFFICIAL_PRODUCT } from "../fixtures";

describe("idle homepage (official config, no bridge)", () => {
	it("renders app title and the shell frame", () => {
		render(() => <App product={OFFICIAL_PRODUCT} />);

		expect(document.title).toBe("Cyber Bear");
		// Without a bridge, character data is absent — the shell shows the
		// scene area and accessible controls but no character-specific copy.
		expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
		expect(screen.getByPlaceholderText("说点什么…")).toBeInTheDocument();
	});

	it("keeps the shell with accessibility landmarks", () => {
		render(() => <App product={OFFICIAL_PRODUCT} />);

		expect(screen.getByRole("navigation", { name: "对话" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /搜索/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "关系档案" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "系统设置" })).toBeDisabled();
	});

	it("opens the backstage sheet from the titlebar", async () => {
		const user = userEvent.setup();
		render(() => <App product={OFFICIAL_PRODUCT} />);

		const backstage = screen.getByRole("button", { name: "幕后" });
		expect(backstage).toBeEnabled();
		await user.click(backstage);
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "关系档案" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "记忆" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "系统设置" })).toBeInTheDocument();
	});
});