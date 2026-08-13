import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/renderer/App";
import { OFFICIAL_PRODUCT } from "../fixtures";

describe("idle homepage (official config)", () => {
	it("renders app title, character identity and the read-only greeting", () => {
		render(() => <App product={OFFICIAL_PRODUCT} />);

		expect(document.title).toBe("Cyber Bear");
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("极光书房 · 雪停以后");
		expect(screen.getByText("极昼")).toBeInTheDocument();
		expect(screen.getByText("旧极光站的守望者")).toBeInTheDocument();
		expect(
			screen.getByText("你回来了。今晚是想说会儿话，还是有东西要我替你看着？"),
		).toBeInTheDocument();
		expect(screen.getByPlaceholderText("对极昼说点什么…")).toHaveAttribute("readonly");
	});

	it("keeps every non-role control disabled and static", () => {
		render(() => <App product={OFFICIAL_PRODUCT} />);

		for (const name of ["进行中的事", "幕后", "关系档案", "系统设置"]) {
			expect(screen.getByRole("button", { name })).toBeDisabled();
		}
		expect(screen.getByRole("button", { name: /搜索/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: /把会议变成报告/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: /把夏天归进月份/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "添加材料" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "新建对话" })).toBeDisabled();
	});

	it("switches scene title and static copy between the two role sections", async () => {
		const user = userEvent.setup();
		render(() => <App product={OFFICIAL_PRODUCT} />);

		const oldStation = screen.getByRole("button", { name: /旧站留下的记录/ });
		await user.click(oldStation);

		expect(oldStation).toHaveAttribute("aria-current", "page");
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("旧站留下的记录");
		expect(
			screen.getByText(
				"我曾信过一次没有依据的“已经修好”。后来档案丢了。所以现在，不知道就是不知道。",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /雪停以后/ })).not.toHaveAttribute("aria-current");

		const home = screen.getByRole("button", { name: /雪停以后/ });
		await user.click(home);

		expect(home).toHaveAttribute("aria-current", "page");
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("极光书房 · 雪停以后");
		expect(
			screen.getByText("你回来了。今晚是想说会儿话，还是有东西要我替你看着？"),
		).toBeInTheDocument();
	});
});
