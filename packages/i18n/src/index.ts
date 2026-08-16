import i18next from "i18next";
import { I18nextProvider, useLanguage, useTranslation } from "solid-i18next";
import { type ProductLocale, resources, supportedProductLocales, zhCN } from "./locales/index.js";

const STORAGE_KEY = "bear-harness.product-locale";

function isProductLocale(value: string | null | undefined): value is ProductLocale {
	return supportedProductLocales.some((locale) => locale === value);
}

const storedLocale = globalThis.localStorage?.getItem(STORAGE_KEY);
const initialLocale: ProductLocale = isProductLocale(storedLocale) ? storedLocale : "zh-CN";
if (globalThis.document) globalThis.document.documentElement.lang = initialLocale;

export const i18n = i18next.createInstance();
void i18n.init({
	resources,
	lng: initialLocale,
	fallbackLng: "zh-CN",
	ns: Object.keys(zhCN),
	defaultNS: "shell",
	nsSeparator: ".",
	keySeparator: ".",
	initAsync: false,
	interpolation: {
		escapeValue: false,
		prefix: "{",
		suffix: "}",
	},
});

export function setProductLocale(locale: ProductLocale): void {
	globalThis.localStorage?.setItem(STORAGE_KEY, locale);
	if (globalThis.document) globalThis.document.documentElement.lang = locale;
	void i18n.changeLanguage(locale);
}

export { type ProductLocale, supportedProductLocales } from "./locales/index.js";
export { I18nextProvider, useLanguage, useTranslation };

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "shell";
		resources: typeof zhCN;
		nsSeparator: ".";
		keySeparator: ".";
	}
}
