import { messages, supportedProductLocales } from "@bear-harness/product-config/locales";
import { describe, expect, it } from "vitest";

function shape(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(shape);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)]));
	}
	return typeof value;
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.values(value).flatMap(strings);
	return [];
}

describe("product locale catalogs", () => {
	it("keeps all three locale catalogs structurally identical", () => {
		expect(supportedProductLocales).toEqual(["zh-CN", "zh-TW", "en"]);
		const baseShape = shape(messages["zh-CN"]);
		for (const locale of supportedProductLocales)
			expect(shape(messages[locale])).toEqual(baseShape);
	});

	it("has a complete English catalog and uses phrase-level OpenCC conversion for Taiwan", () => {
		expect(strings(messages.en).filter((text) => /\p{Script=Han}/u.test(text))).toEqual([]);
		expect(messages["zh-TW"].modelSetup.title).toBe("先連線一個回覆模型");
		expect(messages["zh-TW"].settings.language).toBe("介面語言");
	});
});
