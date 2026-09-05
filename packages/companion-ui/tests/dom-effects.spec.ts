import { describe, expect, it } from "vitest";
import { fitTextareaToContent } from "../src/lib/textarea-sizing.js";
import {
	installTimelineScrollProtection,
	notifyTimelineUserSent,
} from "../src/lib/timeline-scroll.js";

const flushEffects = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("presentation-only DOM effects", () => {
	it("grows the composer to its content and enables overflow only after the CSS cap", () => {
		const textarea = document.createElement("textarea");
		let scrollHeight = 140;
		let clientHeight = 96;
		Object.defineProperty(textarea, "scrollHeight", {
			configurable: true,
			get: () => scrollHeight,
		});
		Object.defineProperty(textarea, "clientHeight", {
			configurable: true,
			get: () => clientHeight,
		});

		fitTextareaToContent(textarea);
		expect(textarea.style.height).toBe("140px");
		expect(textarea.style.overflowY).toBe("auto");

		scrollHeight = 40;
		clientHeight = 40;
		fitTextareaToContent(textarea);
		expect(textarea.style.height).toBe("40px");
		expect(textarea.style.overflowY).toBe("hidden");
	});

	it("protects detached document reading and restores a position per conversation", async () => {
		const thread = document.createElement("section");
		const scrollingElement = document.documentElement;
		const jumpButton = document.createElement("button");
		const originalDocumentScroller = Object.getOwnPropertyDescriptor(document, "scrollingElement");
		const originalScrollHeight = Object.getOwnPropertyDescriptor(scrollingElement, "scrollHeight");
		const originalClientHeight = Object.getOwnPropertyDescriptor(scrollingElement, "clientHeight");
		const originalScrollTop = Object.getOwnPropertyDescriptor(scrollingElement, "scrollTop");
		let documentScrollTop = 0;
		Object.defineProperty(document, "scrollingElement", {
			configurable: true,
			value: scrollingElement,
		});
		Object.defineProperty(scrollingElement, "scrollHeight", {
			configurable: true,
			value: 1_000,
		});
		Object.defineProperty(scrollingElement, "clientHeight", {
			configurable: true,
			value: 200,
		});
		Object.defineProperty(scrollingElement, "scrollTop", {
			configurable: true,
			get: () => documentScrollTop,
			set: (value: number) => {
				documentScrollTop = value;
			},
		});
		thread.dataset.conversationId = "a";
		const controller = installTimelineScrollProtection(thread, jumpButton);

		try {
			await flushEffects();
			expect(scrollingElement.scrollTop).toBe(800);
			expect(thread.scrollTop).toBe(0);

			scrollingElement.scrollTop = 240;
			window.dispatchEvent(new WheelEvent("wheel"));
			await flushEffects();
			expect(jumpButton.hidden).toBe(false);
			thread.append(document.createElement("article"));
			await flushEffects();
			expect(scrollingElement.scrollTop).toBe(240);
			scrollingElement.scrollTop = 425;
			thread.append(document.createTextNode("stream settled"));
			await flushEffects();
			expect(scrollingElement.scrollTop).toBe(240);

			notifyTimelineUserSent("a");
			await flushEffects();
			expect(scrollingElement.scrollTop).toBe(800);
			expect(jumpButton.hidden).toBe(true);

			scrollingElement.scrollTop = 320;
			window.dispatchEvent(new WheelEvent("wheel"));
			await flushEffects();
			thread.dataset.conversationId = "b";
			await flushEffects();
			expect(scrollingElement.scrollTop).toBe(800);

			scrollingElement.scrollTop = 120;
			window.dispatchEvent(new WheelEvent("wheel"));
			await flushEffects();
			thread.dataset.conversationId = "a";
			await flushEffects();
			expect(scrollingElement.scrollTop).toBe(320);
			expect(jumpButton.hidden).toBe(false);

			controller.scrollToLatest();
			expect(scrollingElement.scrollTop).toBe(800);
			expect(jumpButton.hidden).toBe(true);
		} finally {
			controller.dispose();
			if (originalDocumentScroller)
				Object.defineProperty(document, "scrollingElement", originalDocumentScroller);
			else Reflect.deleteProperty(document, "scrollingElement");
			if (originalScrollHeight)
				Object.defineProperty(scrollingElement, "scrollHeight", originalScrollHeight);
			else Reflect.deleteProperty(scrollingElement, "scrollHeight");
			if (originalClientHeight)
				Object.defineProperty(scrollingElement, "clientHeight", originalClientHeight);
			else Reflect.deleteProperty(scrollingElement, "clientHeight");
			if (originalScrollTop)
				Object.defineProperty(scrollingElement, "scrollTop", originalScrollTop);
			else Reflect.deleteProperty(scrollingElement, "scrollTop");
		}
	});
});
