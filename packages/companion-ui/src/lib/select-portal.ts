/**
 * Register the Solid Portal wrapper as a top layer before Kobalte's dialog
 * MutationObserver visits it. Otherwise nested Select portals can be hidden
 * from accessibility while the Select itself remains expanded.
 */
export function markSelectPortalTopLayer(element: Element): void {
	element.setAttribute("data-kb-top-layer", "");
	element.setAttribute("data-react-aria-top-layer", "true");
}
