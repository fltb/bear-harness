import { cleanup } from "@solidjs/testing-library";
import { afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { setProductLocale } from "@bear-harness/i18n";

Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });

// Node 24 exposes a disabled web-storage accessor unless a backing file is
// configured. Keep renderer tests on the browser contract provided by jsdom.
if (!window.localStorage) {
	const values = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			get length() {
				return values.size;
			},
			clear: () => values.clear(),
			getItem: (key: string) => values.get(key) ?? null,
			key: (index: number) => [...values.keys()][index] ?? null,
			removeItem: (key: string) => values.delete(key),
			setItem: (key: string, value: string) => values.set(key, String(value)),
		} satisfies Storage,
	});
}

beforeEach(async () => {
	await setProductLocale("zh-CN");
});

// globals: false — register the cleanup hook explicitly.
afterEach(async () => {
	cleanup();
	await setProductLocale("zh-CN");
	window.localStorage.clear();
});
