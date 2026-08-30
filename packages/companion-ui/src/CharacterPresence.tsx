import { createSignal, Show } from "solid-js";
import type { CharacterDisplay } from "./stores/companion.js";

export type CharacterPresenceLayoutMode = "resting" | "expanded" | "compact";

/**
 * Generic package-driven character presentation. It owns only placement and
 * state animation; the character's appearance and accessible state labels
 * are package assets/data passed through the Host bridge.
 */
export function CharacterPresence(props: {
	character: CharacterDisplay | undefined;
	visualState?: string;
	layout?: CharacterPresenceLayoutMode;
}) {
	const layout = () => props.layout ?? "resting";
	const [loadedAspectRatio, setLoadedAspectRatio] = createSignal<
		{ source: string; ratio: number } | undefined
	>();
	const presenceStyle = (asset: string): string | undefined => {
		const loaded = loadedAspectRatio();
		if (!loaded || loaded.source !== asset) return undefined;
		return String(loaded.ratio);
	};
	const handleAssetLoad = (asset: string, event: Event): void => {
		const image = event.currentTarget as HTMLImageElement;
		const { naturalWidth, naturalHeight } = image;
		const ratio = naturalWidth / naturalHeight;
		if (
			!Number.isFinite(naturalWidth) ||
			!Number.isFinite(naturalHeight) ||
			naturalWidth <= 0 ||
			naturalHeight <= 0 ||
			!Number.isFinite(ratio) ||
			ratio <= 0
		) {
			setLoadedAspectRatio(undefined);
			return;
		}
		setLoadedAspectRatio({ source: asset, ratio });
	};
	const visualState = () => {
		const visual = props.character?.visual;
		if (!visual) return undefined;
		const requested = props.visualState ?? "presence";
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
		<Show when={source()} keyed>
			{(asset) => (
				<div
					class="presence-stage"
					data-state={visualState()}
					data-layout-mode={layout()}
					role="img"
					aria-label={label()}
					style={{ "--presence-aspect-ratio": presenceStyle(asset) }}
				>
					<img
						src={asset}
						alt=""
						draggable={false}
						data-testid="presence-asset"
						onLoad={(event) => handleAssetLoad(asset, event)}
					/>
				</div>
			)}
		</Show>
	);
}
