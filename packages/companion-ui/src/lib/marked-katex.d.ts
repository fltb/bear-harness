import type { MarkedExtension } from "marked";

export default function markedKatex(options?: {
	nonStandard?: boolean;
	strict?: boolean | "error" | "ignore" | "warn";
	throwOnError?: boolean;
}): MarkedExtension;
