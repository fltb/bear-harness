/**
 * The CSS-drawn polar bear (极昼) standing beside the study desk. Decorative
 * in the sense that it carries no interactive behavior, but it is the product
 * subject, so it gets a descriptive image label.
 */
export function JizhouPresence(props: { characterName: string }) {
	return (
		<div class="bear" role="img" aria-label={`原创北极熊${props.characterName}站在书房桌边`}>
			<div class="bear-shadow" />
			<i class="ear l" />
			<i class="ear r" />
			<div class="body" />
			<div class="vest" />
			<div class="head" />
			<div class="log" />
		</div>
	);
}
