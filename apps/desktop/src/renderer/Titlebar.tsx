/**
 * Scene titlebar: decorative traffic lights, the current scene title and
 * static top actions. The real OS window frame handles window controls;
 * this bar only carries the scene heading and disabled action buttons.
 */
export function Titlebar(props: { sceneTitle: string }) {
	return (
		<header class="titlebar">
			<div class="traffic" aria-hidden="true">
				<i />
				<i />
				<i />
			</div>
			<h1 class="scene-title">{props.sceneTitle}</h1>
			<div class="top-actions">
				<button type="button" disabled>
					进行中的事
				</button>
				<button type="button" disabled>
					幕后
				</button>
			</div>
		</header>
	);
}
