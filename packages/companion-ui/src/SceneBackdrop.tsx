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
				<div
					class="scene-backdrop"
					data-surface-layer="scene"
					role="img"
					aria-label={props.scene?.label ?? ""}
				>
					<img src={source} alt="" aria-hidden="true" draggable={false} data-testid="scene-asset" />
				</div>
			)}
		</Show>
	);
}
