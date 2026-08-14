import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useCompanionStore } from "./stores/companion.js";

/**
 * Scene titlebar: decorative traffic lights, the current scene title, the
 * "进行中的事" work pill (live run count from the store, opens the run
 * queue) and the "幕后" backstage button. The real OS window frame handles
 * window controls; this bar only carries scene heading and top actions.
 */

const RUN_STATUS_TEXT: Record<string, string> = {
	enqueued: "排队中",
	running: "正在处理",
	needs_user: "需要你",
	completed: "做好了 · 等你查看",
	failed: "没有做成",
	cancelled: "已取消",
	interrupted: "已中断",
	forced_termination: "被强制终止",
};

export function Titlebar(props: { sceneTitle: string; onOpenBackstage: () => void }) {
	const store = useCompanionStore();
	const [queueOpen, setQueueOpen] = createSignal(false);

	const activeRuns = () =>
		store.runs.filter(
			(run) => run.status === "enqueued" || run.status === "running" || run.status === "needs_user",
		);

	let pillWrapRef: HTMLDivElement | undefined;

	createEffect(() => {
		if (!queueOpen()) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setQueueOpen(false);
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (pillWrapRef && (!(target instanceof Node) || !pillWrapRef.contains(target))) {
				setQueueOpen(false);
			}
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointerDown);
		onCleanup(() => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointerDown);
		});
	});

	return (
		<header class="titlebar">
			<div class="traffic" aria-hidden="true">
				<i />
				<i />
				<i />
			</div>
			<h1 class="scene-title">{props.sceneTitle}</h1>
			<div class="top-actions">
				<div
					class="work-pill-wrap"
					ref={(el) => {
						pillWrapRef = el;
					}}
				>
					<button
						type="button"
						class="work-pill"
						aria-expanded={queueOpen()}
						aria-haspopup="true"
						onClick={() => setQueueOpen((open) => !open)}
					>
						<span class="pulse" aria-hidden="true" />
						进行中的事
						<b>{activeRuns().length}</b>
					</button>
					<Show when={queueOpen()}>
						<div class="queue-pop" role="menu" aria-label="进行中的事">
							<h3>进行中的事</h3>
							<Show
								when={activeRuns().length > 0}
								fallback={<div class="empty">现在没有后台工作</div>}
							>
								<For each={activeRuns()}>
									{(run) => (
										<div class="run">
											<strong>{run.executorProfile}</strong>
											<span>
												{RUN_STATUS_TEXT[run.status] ?? run.status} · {run.id.slice(0, 8)}
											</span>
										</div>
									)}
								</For>
							</Show>
						</div>
					</Show>
				</div>
				<button type="button" onClick={props.onOpenBackstage}>
					幕后
				</button>
			</div>
		</header>
	);
}
