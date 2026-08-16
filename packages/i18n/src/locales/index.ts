import { en } from "./en.js";
import { zhCN } from "./zh-CN.js";
import { zhTW } from "./zh-TW.generated.js";

export { en } from "./en.js";
export { zhCN } from "./zh-CN.js";
export { zhTW } from "./zh-TW.generated.js";

export const supportedProductLocales = ["zh-CN", "zh-TW", "en"] as const;
export type ProductLocale = (typeof supportedProductLocales)[number];

export const resources = {
	"zh-CN": zhCN,
	"zh-TW": zhTW,
	en,
} as const;
