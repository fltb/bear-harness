import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../../src/renderer/App";
import { FORK_PRODUCT } from "../fixtures";

describe("idle homepage (fork config injection)", () => {
	it("replaces app title, document title, character and copy with the fork fixture", () => {
		render(() => <App product={FORK_PRODUCT} />);

		expect(document.title).toBe("North Companion");
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("灯塔 · 夜航未竟");
		expect(screen.getByText("北星")).toBeInTheDocument();
		expect(screen.getByText("极地信号站的守灯人")).toBeInTheDocument();
		expect(screen.getByText("你回来了。今晚是要守灯，还是只想坐一会儿？")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("对北星说点什么…")).toBeInTheDocument();
	});

	it("renders the fork-identity shell with accessibility landmarks", () => {
		render(() => <App product={FORK_PRODUCT} />);

		expect(screen.getByRole("navigation", { name: "对话" })).toBeInTheDocument();
		// Search + system nav stay disabled (not on the bridge yet)
		expect(screen.getByRole("button", { name: /搜索/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "关系档案" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "系统设置" })).toBeDisabled();
	});
});