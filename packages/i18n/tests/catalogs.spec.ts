import { zhCN as publicZhCN } from "@bear-harness/i18n/locales";
import { describe, expect, it } from "vitest";
import { resources, supportedProductLocales } from "../src/locales/index.js";

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
	it("exports locale catalogs through the package public API", () => {
		expect(publicZhCN.modelSetup.dialogLabel).toBe(resources["zh-CN"].modelSetup.dialogLabel);
	});

	it("keeps every locale structurally identical", () => {
		expect(supportedProductLocales).toEqual(["zh-CN", "zh-TW", "en"]);
		const baseShape = shape(resources["zh-CN"]);
		for (const locale of supportedProductLocales) {
			expect(shape(resources[locale])).toEqual(baseShape);
		}
	});

	it("keeps English translated and uses phrase-level OpenCC output for Taiwan", () => {
		expect(strings(resources.en).filter((text) => /\p{Script=Han}/u.test(text))).toEqual([]);
		expect(resources["zh-TW"].modelSetup.title).toBe("先連線一個回覆模型");
		expect(resources["zh-TW"].settings.language).toBe("介面語言");
	});
});
