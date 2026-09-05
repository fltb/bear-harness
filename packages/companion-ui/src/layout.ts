export type AppLayoutMode = "mobile" | "window" | "fullscreen";

/** Canonical visual-gate viewports. Compatibility sizes are tested separately. */
export const CANONICAL_LAYOUT_VIEWPORTS = {
	mobile: { width: 390, height: 844 },
	window: { width: 1280, height: 800 },
	fullscreen: { width: 1920, height: 1080 },
} as const;

export const MOBILE_LAYOUT_MAX_WIDTH = 767;
export const FULLSCREEN_LAYOUT_MIN_WIDTH = 1600;

export function layoutModeForWidth(width: number): AppLayoutMode {
	if (width <= MOBILE_LAYOUT_MAX_WIDTH) return "mobile";
	if (width >= FULLSCREEN_LAYOUT_MIN_WIDTH) return "fullscreen";
	return "window";
}
