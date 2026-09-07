import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { MessageContent, renderMarkdown } from "../src/MessageContent.js";
import { nativeSource } from "../src/NativeMessageContent.js";

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

	it("opens only absolute HTTPS links through a separate safe browsing context", () => {
		const view = render(() => (
			<MessageContent
				text={
					"[安全链接](https://example.com/path) [HTTP](http://example.com) [相对路径](/internal)"
				}
				format="markdown"
			/>
		));

		expect(view.getByText("安全链接")).toHaveAttribute("href", "https://example.com/path");
		expect(view.getByText("安全链接")).toHaveAttribute("target", "_blank");
		expect(view.getByText("安全链接")).toHaveAttribute("rel", "noopener noreferrer");
		expect(view.getByText("HTTP")).not.toHaveAttribute("href");
		expect(view.getByText("相对路径")).not.toHaveAttribute("href");
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

	it("copies the exact source of each code block through a stateless callback", () => {
		const copied: Array<{ code: string; index: number }> = [];
		const view = render(() => (
			<MessageContent
				text={"```ts\nconst first = '<safe>';\n```\n\n```\nsecond line\n```"}
				format="markdown"
				codeCopyLabel="复制代码"
				codeCopiedLabel="代码已复制"
				onCopyCode={(code, index) => copied.push({ code, index })}
			/>
		));

		const actions = view.getAllByRole("button", { name: "复制代码" });
		expect(actions).toHaveLength(2);
		fireEvent.click(actions[0]);
		fireEvent.click(actions[1]);
		expect(copied).toEqual([
			{ code: "const first = '<safe>';\n", index: 0 },
			{ code: "second line\n", index: 1 },
		]);
	});

	it("keeps incomplete streaming syntax safe and converges to the settled structure", () => {
		const fragments = [
			"**未闭合",
			"`inline",
			"```ts\nconst value",
			"[链接](https://example.com",
			"| 项目 | 状态 |\n| ---",
			"$$\nE = mc^",
		];
		for (const fragment of fragments) expect(() => renderMarkdown(fragment)).not.toThrow();

		const complete = "**完成**\n\n```ts\nconst value = 1;\n```\n\n$$\nE = mc^2\n$$";
		const once = renderMarkdown(complete);
		const [text, setText] = createSignal(complete.slice(0, 24));
		const view = render(() => <MessageContent text={text()} format="markdown" streaming />);
		setText(complete);
		expect(view.getByTestId("message-markdown").innerHTML).toBe(once);
	});

	it("rejects executable links, remote images, forms, and raw interactive HTML", () => {
		const request = vi.spyOn(globalThis, "fetch");
		const view = render(() => (
			<MessageContent
				text={
					'<form><input autofocus onfocus="alert(1)"></form>\n\n<button>伪按钮</button>\n\n[脚本](javascript:alert(1)) [数据](data:text/html,bad) ![远程](https://bad.test/tracker.png)'
				}
				format="markdown"
			/>
		));

		expect(view.container.getElementsByTagName("form")).toHaveLength(0);
		expect(view.queryByRole("textbox")).toBeNull();
		expect(view.queryByRole("button")).toBeNull();
		expect(view.queryByRole("img")).toBeNull();
		expect(view.getByText("脚本")).not.toHaveAttribute("href");
		expect(view.getByText("数据")).not.toHaveAttribute("href");
		expect(request).not.toHaveBeenCalled();
		request.mockRestore();
	});

	it("bounds native diagnostic source and omits binary and private provider payloads", () => {
		const source = nativeSource({
			data: "a".repeat(100_000),
			signature: "secret",
			thinkingSignature: "also-secret",
			detail: Array.from({ length: 10 }, (_, index) => `${index}:${"b".repeat(10_000)}`),
		});

		expect(source.length).toBeLessThan(33_000);
		expect(source).toContain("[binary data omitted: 100000 characters]");
		expect(source).toContain("[native source truncated]");
		expect(source).not.toContain("secret");
	});
});
