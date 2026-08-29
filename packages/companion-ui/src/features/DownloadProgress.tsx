import { Show } from "solid-js";
import { Button } from "../ui/primitives.js";

/** Transport- and model-independent download presentation; the caller owns the task. */
export function DownloadProgress(props: {
	label: string;
	downloadedBytes: number;
	totalBytes?: number;
	cancelLabel: string;
	onCancel?: () => void;
	cancelling?: boolean;
}) {
	const percentage = () =>
		props.totalBytes && props.totalBytes > 0
			? Math.min(100, Math.max(0, (props.downloadedBytes / props.totalBytes) * 100))
			: undefined;
	const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;
	return (
		<div class="download-progress" aria-busy="true">
			<p role="status">{props.label}</p>
			<Show when={percentage() !== undefined} fallback={<progress aria-label={props.label} />}>
				<progress aria-label={props.label} max={100} value={percentage() ?? 0} />
			</Show>
			<Show when={props.downloadedBytes > 0}>
				<p>
					{bytes(props.downloadedBytes)}
					<Show when={props.totalBytes}>
						{(total) => (
							<>
								{" "}
								/ {bytes(total())} ({percentage()?.toFixed(0)}%)
							</>
						)}
					</Show>
				</p>
			</Show>
			<Show when={props.onCancel}>
				<Button type="button" disabled={props.cancelling} onClick={() => props.onCancel?.()}>
					{props.cancelLabel}
				</Button>
			</Show>
		</div>
	);
}
