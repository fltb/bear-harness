import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
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
		expect(screen.getByPlaceholderText("对北星说点什么…")).toHaveAttribute("readonly");
	});

	it("switches fork scene titles and static lines between sections", async () => {
		const user = userEvent.setup();
		render(() => <App product={FORK_PRODUCT} />);

		await user.click(screen.getByRole("button", { name: /旧信号站/ }));
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("旧信号站");
		expect(
			screen.getByText("旧信号站的灯灭了三年。后来它重新亮起时，我不再相信没人说过的话。"),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /灯塔|夜航/ }));
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("灯塔 · 夜航未竟");
		expect(screen.getByText("你回来了。今晚是要守灯，还是只想坐一会儿？")).toBeInTheDocument();
	});
});
