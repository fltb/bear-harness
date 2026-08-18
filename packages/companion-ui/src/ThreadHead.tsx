import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useCompanionStore } from "./stores/companion.js";

/**
 * Thread head: the current scene title and the "进行中的事" work pill
 * (live run count from the store, opens the run queue). The OS window
 * frame provides the real title bar, so this header only carries thread
 * context and top actions.
 */

export function ThreadHead(props: { sceneTitle: string }) {
	const [t] = useTranslation(undefined, { i18n });
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
		<header class="thread-head">
			<h1 class="scene-title">{props.sceneTitle}</h1>
			<div
				class="work-pill-wrap"
				ref={(el) => {
					pillWrapRef = el;
				}}
			>
				<Button
					type="button"
					class="work-pill"
					aria-expanded={queueOpen()}
					aria-haspopup="true"
					onClick={() => setQueueOpen((open) => !open)}
				>
					<span class="pulse" aria-hidden="true" />
					{t("threadHead.runningWork")}
					<b>{activeRuns().length}</b>
				</Button>
				<Show when={queueOpen()}>
					<div class="queue-pop" role="menu" aria-label={t("threadHead.runningWork")}>
						<h3>{t("threadHead.runningWork")}</h3>
						<Show
							when={activeRuns().length > 0}
							fallback={<div class="empty">{t("threadHead.noRunningWork")}</div>}
						>
							<For each={activeRuns()}>
								{(run, index) => (
									<div class="run">
										<strong>
											{t("threadHead.runningWorkItem")} {index() + 1}
										</strong>
										<span>
											{t(`threadHead.runStatuses.${run.status}`) ?? t("threadHead.statusUpdating")}
										</span>
									</div>
								)}
							</For>
						</Show>
					</div>
				</Show>
			</div>
		</header>
	);
}
