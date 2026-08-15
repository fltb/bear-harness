import { Show } from "solid-js";
import type { SceneDisplay } from "./stores/companion.js";

/**
 * Generic scene layer. The Host turns the selected package asset into a
 * data URL, so the sandboxed renderer never reads package files directly.
 */
export function SceneBackdrop(props: { scene: SceneDisplay | undefined }) {
	return (
		<Show when={props.scene?.backgroundUrl}>
			{(source) => (
				<div class="scene-backdrop" aria-hidden="true">
					<img src={source()} alt="" draggable={false} />
				</div>
			)}
		</Show>
	);
}
