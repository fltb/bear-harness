/** Presentation-only motion helpers. They do not retain product data. */
export function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

export function finishMotionExitImmediately(complete: () => void): void {
	if (prefersReducedMotion()) queueMicrotask(complete);
}
