import { Show } from "solid-js";
import type { SceneDisplay } from "./stores/companion.js";

/**
 * Generic scene layer. The Host turns the selected package asset into a
 * data URL, so the sandboxed renderer never reads package files directly.
 */
export function SceneBackdrop(props: { scene: SceneDisplay | undefined }) {
	return (
		<Show when={props.scene?.backgroundUrl} keyed>
			{(source) => (
				<div class="scene-backdrop">
					<img src={source} alt={props.scene?.label ?? ""} draggable={false} />
				</div>
			)}
		</Show>
	);
}
