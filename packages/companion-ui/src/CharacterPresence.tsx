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
	const visualState = () => {
		const visual = props.character?.visual;
		if (!visual) return undefined;
		const requested = props.visualState ?? VISUAL_STATE_BY_PRESENCE[props.presence];
		return visual.expressions[requested] ? requested : visual.defaultExpressionId;
	};
	const source = () => {
		const state = visualState();
		return state ? props.character?.visual.expressions[state] : undefined;
	};
	const label = () => {
		const state = visualState();
		return state ? props.character?.visual.expressionLabels[state] : undefined;
	};

	return (
		<Show when={source()}>
			{(asset) => (
				<div class="presence-stage" data-state={visualState()} role="img" aria-label={label()}>
					<img src={asset()} alt="" draggable={false} data-testid="presence-asset" />
				</div>
			)}
		</Show>
	);
}
