// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForPackagedRendererPage } from "../../e2e/packaged-renderer-page.js";

class FakePage {
	constructor(private address: string) {}
	url() {
		return this.address;
	}
	navigate(address: string) {
		this.address = address;
	}
}

class FakeContext extends EventEmitter {
	constructor(private readonly currentPages: FakePage[]) {
		super();
	}
	pages() {
		return this.currentPages;
	}
	add(page: FakePage) {
		this.currentPages.push(page);
		this.emit("page", page);
	}
}

describe("packaged renderer selection", () => {
	it("selects an existing file renderer without waiting for another page", async () => {
		const renderer = new FakePage("file:///resources/app.asar/dist/renderer/index.html");
		const context = new FakeContext([new FakePage("about:blank"), renderer]);
		await expect(waitForPackagedRendererPage(context, 20)).resolves.toBe(renderer);
	});

	it("waits for a later file renderer and ignores unrelated pages", async () => {
		const context = new FakeContext([new FakePage("about:blank")]);
		const selected = waitForPackagedRendererPage(context, 100);
		context.add(new FakePage("devtools://devtools/bundled/inspector.html"));
		const renderer = new FakePage("file:///resources/app.asar/dist/renderer/index.html");
		context.add(renderer);
		await expect(selected).resolves.toBe(renderer);
	});

	it("detects an existing page that later navigates to the packaged renderer", async () => {
		const page = new FakePage("about:blank");
		const context = new FakeContext([page]);
		const selected = waitForPackagedRendererPage(context, 100);
		setTimeout(
			() => page.navigate("file:///D:/a/bear-harness/resources/app.asar/dist/renderer/index.html"),
			10,
		);
		await expect(selected).resolves.toBe(page);
	});

	it("fails clearly when no packaged renderer appears", async () => {
		const context = new FakeContext([
			new FakePage("about:blank"),
			new FakePage("chrome://version/"),
		]);
		await expect(waitForPackagedRendererPage(context, 10)).rejects.toThrow(
			"packaged app did not create a file renderer; observed pages: about:blank, chrome://version/",
		);
	});
});
