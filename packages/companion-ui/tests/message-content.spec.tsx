import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { MessageContent } from "../src/MessageContent.js";

describe("MessageContent", () => {
	it("renders Markdown, highlighted code, tables, and KaTeX from reactive props", () => {
		const [text, setText] = createSignal("**正在流式输出");
		const view = render(() => <MessageContent text={text()} format="markdown" streaming={true} />);

		expect(view.getByTestId("message-content")).toHaveAttribute("aria-busy", "true");
		expect(view.getByText("**正在流式输出").tagName).toBe("P");

		setText(`**完成**

| 项目 | 状态 |
| --- | --- |
| 流式 | 正常 |

\`\`\`ts
const answer = 42;
\`\`\`

$$
E = mc^2
$$`);

		expect(view.getByText("完成").tagName).toBe("STRONG");
		expect(view.getByRole("table")).toBeInTheDocument();
		expect(
			view.getByText(
				(_content, element) =>
					element?.tagName === "CODE" && element.textContent?.trim() === "const answer = 42;",
			).tagName,
		).toBe("CODE");
		expect(
			view.getByText((_content, element) => element?.tagName.toLowerCase() === "math").tagName,
		).toBe("math");
	});

	it("keeps plain user text literal", () => {
		const view = render(() => <MessageContent text="**不是粗体**" format="plain" />);

		expect(view.getByText("**不是粗体**")).toBeInTheDocument();
		expect(view.getByText("**不是粗体**").tagName).toBe("P");
	});

	it("escapes model HTML, strips unsafe links, and does not load Markdown images", () => {
		const view = render(() => (
			<MessageContent
				text={
					'<img src=x onerror="alert(1)"> [危险](javascript:alert(1)) ![跟踪](https://bad.test/pixel.png)'
				}
				format="markdown"
			/>
		));

		expect(view.queryByRole("img")).toBeNull();
		expect(view.getByText("危险")).not.toHaveAttribute("href");
		expect(view.container).toHaveTextContent("跟踪");
	});

	it("falls back to plain highlighting for missing and unknown code languages", () => {
		const view = render(() => (
			<MessageContent
				text={"```unknown-language\nconst unknown = true;\n```\n\n```\nplain block\n```"}
				format="markdown"
			/>
		));

		expect(view.getByText("const unknown = true;")).toBeInTheDocument();
		expect(view.getByText("plain block")).toBeInTheDocument();
	});
});
