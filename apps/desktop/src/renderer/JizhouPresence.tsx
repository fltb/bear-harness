import { Show } from "solid-js";
import { useCompanionStore } from "./stores/companion.js";

/**
 * The CSS-drawn polar bear (极昼) standing beside the study desk. Decorative
 * art stays exactly as the brand reference; the only addition is the
 * `data-state` mapping (listening / thinking / needs_user / result_ready /
 * problem / idle) which drives subtle CSS state changes, plus a visually
 * hidden live region so screen readers hear the state transitions.
 */

const PRESENCE_TEXT: Record<string, string> = {
	listening: "极昼在听",
	thinking: "极昼在想",
	needs_user: "极昼需要你",
	result_ready: "极昼把结果带回来了",
	problem: "极昼遇到问题",
	idle: "",
};

export function JizhouPresence(props: { characterName: string }) {
	const store = useCompanionStore();

	return (
		<div
			class="bear"
			role="img"
			aria-label={`原创北极熊${props.characterName}站在书房桌边`}
			data-state={store.presence}
		>
			<div class="bear-shadow" />
			<i class="ear l" />
			<i class="ear r" />
			<div class="body" />
			<div class="vest" />
			<div class="head" />
			<div class="log" />
			<Show when={PRESENCE_TEXT[store.presence] !== undefined}>
				<span class="sr-only" aria-live="polite">
					{PRESENCE_TEXT[store.presence]}
				</span>
			</Show>
		</div>
	);
}
