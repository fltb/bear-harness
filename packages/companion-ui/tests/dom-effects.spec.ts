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

	it("protects detached reading and restores an independent position per conversation", async () => {
		const thread = document.createElement("section");
		Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 1_000 });
		Object.defineProperty(thread, "clientHeight", { configurable: true, value: 200 });
		const jumpButton = document.createElement("button");
		thread.dataset.conversationId = "a";
		const controller = installTimelineScrollProtection(thread, jumpButton);

		await flushEffects();
		expect(thread.scrollTop).toBe(1_000);

		thread.scrollTop = 240;
		thread.dispatchEvent(new WheelEvent("wheel"));
		await flushEffects();
		expect(jumpButton.hidden).toBe(false);
		thread.append(document.createElement("article"));
		await flushEffects();
		expect(thread.scrollTop).toBe(240);
		thread.scrollTop = 425;
		thread.append(document.createTextNode("stream settled"));
		await flushEffects();
		expect(thread.scrollTop).toBe(240);

		notifyTimelineUserSent("a");
		await flushEffects();
		expect(thread.scrollTop).toBe(1_000);
		expect(jumpButton.hidden).toBe(true);

		thread.scrollTop = 320;
		thread.dispatchEvent(new WheelEvent("wheel"));
		await flushEffects();
		thread.dataset.conversationId = "b";
		await flushEffects();
		expect(thread.scrollTop).toBe(1_000);

		thread.scrollTop = 120;
		thread.dispatchEvent(new WheelEvent("wheel"));
		await flushEffects();
		thread.dataset.conversationId = "a";
		await flushEffects();
		expect(thread.scrollTop).toBe(320);
		expect(jumpButton.hidden).toBe(false);

		controller.scrollToLatest();
		expect(thread.scrollTop).toBe(1_000);
		expect(jumpButton.hidden).toBe(true);
		controller.dispose();
	});
});
