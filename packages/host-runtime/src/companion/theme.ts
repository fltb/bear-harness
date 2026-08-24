import { z } from "@bear-harness/schema";
import type { CharacterTheme, SystemThemeTokens } from "@bear-harness/protocol/schema";

export const SYSTEM_THEME_TOKEN_NAMES = [
	"canvas",
	"surface",
	"surface_raised",
	"surface_interactive",
	"surface_selected",
	"text",
	"text_muted",
	"text_on_accent",
	"accent",
	"accent_hover",
	"border",
	"border_focus",
	"success",
	"warning",
	"danger",
] as const;

type SystemThemeTokenName = (typeof SYSTEM_THEME_TOKEN_NAMES)[number];

type CharacterThemeOverrides = {
	radius?: Partial<CharacterTheme["radius"]>;
	tokens?: Partial<SystemThemeTokens>;
	font?: Partial<CharacterTheme["font"]>;
};

const OpaqueHexColorSchema = z
	.string()
	.regex(/^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/, "must be an opaque #RGB or #RRGGBB color");

const ThemeOverrideTokensSchema = z.strictObject({
	canvas: OpaqueHexColorSchema.optional(),
	surface: OpaqueHexColorSchema.optional(),
	surface_raised: OpaqueHexColorSchema.optional(),
	surface_interactive: OpaqueHexColorSchema.optional(),
	surface_selected: OpaqueHexColorSchema.optional(),
	text: OpaqueHexColorSchema.optional(),
	text_muted: OpaqueHexColorSchema.optional(),
	text_on_accent: OpaqueHexColorSchema.optional(),
	accent: OpaqueHexColorSchema.optional(),
	accent_hover: OpaqueHexColorSchema.optional(),
	border: OpaqueHexColorSchema.optional(),
	border_focus: OpaqueHexColorSchema.optional(),
	success: OpaqueHexColorSchema.optional(),
	warning: OpaqueHexColorSchema.optional(),
	danger: OpaqueHexColorSchema.optional(),
});

const SafeCssValueSchema = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !/[;{}<>]/.test(value) && !/url\s*\(/i.test(value), "unsafe CSS value");

export const CharacterThemeOverridesSchema = z
	.strictObject({
		radius: z
			.strictObject({
				sm: z.number().finite().min(0).max(40).optional(),
				md: z.number().finite().min(0).max(40).optional(),
				lg: z.number().finite().min(0).max(40).optional(),
			})
			.optional(),
		tokens: ThemeOverrideTokensSchema.optional(),
		font: z
			.strictObject({ body: SafeCssValueSchema.optional(), heading: SafeCssValueSchema.optional() })
			.optional(),
	})
	.optional();

/** Host-owned `arctic-console` defaults. Role packages override these partially. */
export const ARCTIC_CONSOLE_THEME: CharacterTheme = {
	radius: { sm: 8, md: 12, lg: 16 },
	tokens: {
		canvas: "#111113",
		surface: "#18191b",
		surface_raised: "#212225",
		surface_interactive: "#272a2d",
		surface_selected: "#0b3a48",
		text: "#ecedee",
		text_muted: "#9ba1a6",
		text_on_accent: "#07171c",
		accent: "#00a2c7",
		accent_hover: "#4ccce6",
		border: "#43484e",
		border_focus: "#4ccce6",
		success: "#86ead4",
		warning: "#ffc53d",
		danger: "#ff9592",
	},
	font: {
		body: '"Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif',
		heading: '"Songti SC", "STSong", Georgia, serif',
	},
};

function srgbChannel(value: string): number {
	const channel = Number.parseInt(value, 16) / 255;
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
	const hex =
		color.length === 4
			? [...color.slice(1)].map((channel) => channel + channel).join("")
			: color.slice(1);
	return (
		0.2126 * srgbChannel(hex.slice(0, 2)) +
		0.7152 * srgbChannel(hex.slice(2, 4)) +
		0.0722 * srgbChannel(hex.slice(4, 6))
	);
}

function contrastRatio(foreground: string, background: string): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	const light = Math.max(foregroundLuminance, backgroundLuminance);
	const dark = Math.min(foregroundLuminance, backgroundLuminance);
	return (light + 0.05) / (dark + 0.05);
}

function requireContrast(
	tokens: SystemThemeTokens,
	foreground: SystemThemeTokenName,
	background: SystemThemeTokenName,
	minimum: number,
): void {
	const ratio = contrastRatio(tokens[foreground], tokens[background]);
	if (ratio < minimum) {
		throw new Error(
			`theme tokens ${foreground}/${background} contrast ${ratio.toFixed(2)}:1 is below ${minimum}:1`,
		);
	}
}

export function validateResolvedTheme(tokens: SystemThemeTokens): void {
	requireContrast(tokens, "text", "canvas", 4.5);
	requireContrast(tokens, "text", "surface", 4.5);
	requireContrast(tokens, "text", "surface_raised", 4.5);
	requireContrast(tokens, "text_muted", "canvas", 4.5);
	requireContrast(tokens, "text_on_accent", "accent", 4.5);
	requireContrast(tokens, "success", "canvas", 4.5);
	requireContrast(tokens, "warning", "canvas", 4.5);
	requireContrast(tokens, "danger", "canvas", 4.5);
	requireContrast(tokens, "border_focus", "surface", 3);
}

export function resolveCharacterTheme(
	overrides: CharacterThemeOverrides | undefined,
): CharacterTheme {
	const result = {
		radius: { ...ARCTIC_CONSOLE_THEME.radius, ...overrides?.radius },
		tokens: { ...ARCTIC_CONSOLE_THEME.tokens, ...overrides?.tokens },
		font: { ...ARCTIC_CONSOLE_THEME.font, ...overrides?.font },
	};
	validateResolvedTheme(result.tokens);
	return result;
}
