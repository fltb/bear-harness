/**
 * Decorative aurora study: window, mountains, shelf, books, lamp and desk,
 * all drawn in CSS. Purely decorative — `aria-hidden` and out of the tab
 * order.
 */
export function AuroraScene() {
	return (
		<div class="scene" aria-hidden="true">
			<div class="window">
				<div class="mountains" />
			</div>
			<div class="shelf">
				<div class="books" />
			</div>
			<div class="lamp" />
			<div class="desk" />
		</div>
	);
}
