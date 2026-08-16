import { cleanup } from "@solidjs/testing-library";
import { afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { setProductLocale } from "@bear-harness/i18n";

Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });

beforeEach(() => {
	setProductLocale("zh-CN");
});

// globals: false — register the cleanup hook explicitly.
afterEach(() => {
	cleanup();
	setProductLocale("zh-CN");
	localStorage.clear();
});
