import i18next from "i18next";
import { I18nextProvider, useLanguage, useTranslation } from "solid-i18next";
import { type ProductLocale, resources, supportedProductLocales, zhCN } from "./locales/index.js";

const STORAGE_KEY = "bear-harness.product-locale";

function isProductLocale(value: unknown): value is ProductLocale {
	return typeof value === "string" && supportedProductLocales.some((locale) => locale === value);
}
function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

export { isProductLocale };

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

export async function setProductLocale(locale: unknown): Promise<void> {
	if (!isProductLocale(locale)) {
		throw new Error(`Unsupported product locale: ${String(locale)}`);
	}

	let storage: Storage | undefined;
	let storedValue: string | null = null;
	try {
		storage = globalThis.localStorage;
		storedValue = storage?.getItem(STORAGE_KEY) ?? null;
	} catch (cause) {
		throw new Error(`Unable to read product locale from storage: ${messageOf(cause)}`, { cause });
	}

	const previousLocale = isProductLocale(i18n.language) ? i18n.language : initialLocale;
	const previousDocumentLanguage = globalThis.document?.documentElement.lang;
	const rollbackLanguage = async (): Promise<unknown[]> => {
		if (i18n.language === previousLocale) return [];
		try {
			await i18n.changeLanguage(previousLocale);
			return [];
		} catch (cause) {
			return [cause];
		}
	};

	try {
		await i18n.changeLanguage(locale);
	} catch (cause) {
		const rollbackErrors = await rollbackLanguage();
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[cause, ...rollbackErrors],
				"Unable to change product locale; rollback failed",
			);
		}
		throw new Error(`Unable to change product locale: ${messageOf(cause)}`, { cause });
	}

	let documentUpdated = false;
	try {
		storage?.setItem(STORAGE_KEY, locale);
		if (globalThis.document) {
			globalThis.document.documentElement.lang = locale;
			documentUpdated = true;
		}
	} catch (cause) {
		const rollbackErrors: unknown[] = await rollbackLanguage();
		if (documentUpdated && globalThis.document) {
			try {
				globalThis.document.documentElement.lang = previousDocumentLanguage ?? "";
			} catch (rollbackCause) {
				rollbackErrors.push(rollbackCause);
			}
		}
		if (storage) {
			try {
				if (storedValue === null) storage.removeItem(STORAGE_KEY);
				else storage.setItem(STORAGE_KEY, storedValue);
			} catch (rollbackCause) {
				rollbackErrors.push(rollbackCause);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[cause, ...rollbackErrors],
				"Unable to persist product locale; rollback failed",
			);
		}
		throw new Error(`Unable to persist product locale: ${messageOf(cause)}`, { cause });
	}
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
