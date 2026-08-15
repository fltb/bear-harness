import { Show } from "solid-js";
import type { CharacterDisplay, PresenceState } from "./stores/companion.js";

const VISUAL_STATE_BY_PRESENCE: Record<PresenceState, string> = {
	idle: "presence",
	listening: "listening",
	thinking: "thinking",
	needs_user: "needs_user",
	result_ready: "result_ready",
	problem: "problem",
};

/**
 * Generic package-driven character presentation. It owns only placement and
 * state animation; the character's appearance and accessible state labels
 * are package assets/data passed through the Host bridge.
 */
export function CharacterPresence(props: {
	character: CharacterDisplay | undefined;
	presence: PresenceState;
	visualState?: string;
}) {
	const visualState = () =>
		props.visualState && props.character?.visual.presence[props.visualState]
			? props.visualState
			: VISUAL_STATE_BY_PRESENCE[props.presence];
	const source = () => props.character?.visual.presence[visualState()];
	const label = () => props.character?.visual.stateLabels[visualState()];

	return (
		<Show when={source()}>
			{(asset) => (
				<div class="presence-stage" data-state={visualState()} role="img" aria-label={label()}>
					<img src={asset()} alt="" draggable={false} />
				</div>
			)}
		</Show>
	);
}
