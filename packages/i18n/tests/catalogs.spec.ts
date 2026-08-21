import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zhCN as publicZhCN } from "@bear-harness/i18n/locales";
import { describe, expect, it } from "vitest";
import { i18n } from "../src/index.js";
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

	it("regenerates Taiwan output from the current source catalog", () => {
		const packageRoot = fileURLToPath(new URL("..", import.meta.url));
		const generatorPath = fileURLToPath(new URL("../scripts/generate-zh-tw.mjs", import.meta.url));
		const generatedPath = fileURLToPath(
			new URL("../src/locales/zh-TW.generated.ts", import.meta.url),
		);

		execFileSync(process.execPath, [generatorPath], { cwd: packageRoot });
		const generated = readFileSync(generatedPath, "utf8");
		expect(generated).toContain('"sourceLanguage": "資料語言：{language}"');
		expect(generated).not.toContain("{{language}}");
	});

	it("renders source-language placeholders with configured delimiters", () => {
		expect(i18n.getFixedT("zh-CN")("canonStudio.sourceLanguage", { language: "中文" })).toBe(
			"资料语言：中文",
		);
		expect(i18n.getFixedT("zh-TW")("canonStudio.sourceLanguage", { language: "中文" })).toBe(
			"資料語言：中文",
		);
	});

	it("keeps English translated and uses phrase-level OpenCC output for Taiwan", () => {
		expect(strings(resources.en).filter((text) => /\p{Script=Han}/u.test(text))).toEqual([]);
		expect(resources["zh-TW"].modelSetup.title).toBe("先連線一個回覆模型");
		expect(resources["zh-TW"].settings.language).toBe("介面語言");
	});
});
