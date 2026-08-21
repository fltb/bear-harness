import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, setProductLocale } from "../src/index.js";

const STORAGE_KEY = "bear-harness.product-locale";

type MemoryStorage = Storage & { values: Map<string, string>; failWrites: boolean };

function installEnvironment(): MemoryStorage {
	const values = new Map<string, string>([[STORAGE_KEY, "zh-CN"]]);
	const storage = {
		values,
		failWrites: false,
		getItem(key: string) {
			return values.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			if (storage.failWrites) throw new Error("storage unavailable");
			values.set(key, value);
		},
		removeItem(key: string) {
			values.delete(key);
		},
	} as MemoryStorage;
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: { documentElement: { lang: "zh-CN" } },
	});
	return storage;
}

beforeEach(async () => {
	installEnvironment();
	await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("product locale runtime boundary", () => {
	it("rejects unsupported untyped locale values before changing state", async () => {
		await expect(setProductLocale("pirate" as unknown)).rejects.toThrow(
			"Unsupported product locale",
		);
		expect(i18n.language).toBe("zh-CN");
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(localStorage.getItem(STORAGE_KEY)).toBe("zh-CN");
	});

	it("surfaces a language-change failure without persisting or updating the document", async () => {
		vi.spyOn(i18n, "changeLanguage").mockRejectedValueOnce(
			new Error("language backend unavailable"),
		);

		await expect(setProductLocale("en")).rejects.toThrow("Unable to change product locale");
		expect(i18n.language).toBe("zh-CN");
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(localStorage.getItem(STORAGE_KEY)).toBe("zh-CN");
	});

	it("rolls language back when persistence fails", async () => {
		const storage = installEnvironment();
		await i18n.changeLanguage("zh-CN");
		storage.failWrites = true;

		await expect(setProductLocale("en")).rejects.toThrow("Unable to persist product locale");
		expect(i18n.language).toBe("zh-CN");
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(storage.values.get(STORAGE_KEY)).toBe("zh-CN");
	});

	it("persists and exposes the new locale only after language change succeeds", async () => {
		await setProductLocale("en");

		expect(i18n.language).toBe("en");
		expect(document.documentElement.lang).toBe("en");
		expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
	});
});
