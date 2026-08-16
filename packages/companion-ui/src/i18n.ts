import {
	messages,
	type ProductLocale,
	supportedProductLocales,
	type zhCN,
} from "@bear-harness/product-config/locales";
import { flatten, translator } from "@solid-primitives/i18n";
import { createSignal } from "solid-js";

const STORAGE_KEY = "bear-harness.product-locale";

function isProductLocale(value: string | null | undefined): value is ProductLocale {
	return supportedProductLocales.some((locale) => locale === value);
}

const storedLocale = globalThis.localStorage?.getItem(STORAGE_KEY);
export const [productLocale, setLocaleSignal] = createSignal<ProductLocale>(
	isProductLocale(storedLocale) ? storedLocale : "zh-CN",
);

export function setProductLocale(locale: ProductLocale): void {
	globalThis.localStorage?.setItem(STORAGE_KEY, locale);
	setLocaleSignal(locale);
}

type LeafPath<Value> = {
	[Key in keyof Value & string]: Value[Key] extends readonly unknown[]
		? Key
		: Value[Key] extends object
			? `${Key}.${LeafPath<Value[Key]>}`
			: Key;
}[keyof Value & string];

type AtPath<Value, Path extends string> = Path extends `${infer Key}.${infer Rest}`
	? Key extends keyof Value
		? AtPath<Value[Key], Rest>
		: never
	: Path extends keyof Value
		? Value[Path]
		: never;

type WidenValue<Value> = Value extends string
	? string
	: Value extends readonly (infer Item)[]
		? readonly WidenValue<Item>[]
		: Value extends object
			? { readonly [Key in keyof Value]: WidenValue<Value[Key]> }
			: Value;

type MessageKey = LeafPath<typeof zhCN>;
type MessageTranslator = <Key extends MessageKey>(key: Key) => WidenValue<AtPath<typeof zhCN, Key>>;

/** Type-safe, reactive product-copy translator supplied by Solid Primitives. */
export const t = translator(
	() =>
		flatten(messages[productLocale()] as unknown as typeof zhCN) as unknown as Record<
			string,
			unknown
		>,
) as unknown as MessageTranslator;

export { type ProductLocale, supportedProductLocales };
