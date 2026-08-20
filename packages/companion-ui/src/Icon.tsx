import type { IconDefinition } from "@fortawesome/free-solid-svg-icons";
import type { JSX } from "solid-js";
import { For } from "solid-js";

export interface IconProps {
	icon: IconDefinition;
	class?: string;
}

/** Render one tree-shakeable Font Awesome definition without a DOM runtime. */
export function Icon(props: IconProps): JSX.Element {
	const [width, height, , , pathData] = props.icon.icon;
	const paths = Array.isArray(pathData) ? pathData : [pathData];

	return (
		<svg
			class={props.class}
			aria-hidden="true"
			tabindex="-1"
			width="1em"
			height="1em"
			viewBox={`0 0 ${width} ${height}`}
			xmlns="http://www.w3.org/2000/svg"
		>
			<For each={paths}>{(path) => <path d={path} fill="currentColor" />}</For>
		</svg>
	);
}
