import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { For, onCleanup, onMount, Show } from "solid-js";
import { useShellWorkflowStore } from "./stores/shell-workflows.js";
import { WorkRunCard } from "./WorkPanel.js";

/**
 * Thread head: the current scene title and the "进行中的事" work pill
 * (live run count from the store, opens the run queue). The OS window
 * frame provides the real title bar, so this header only carries thread
 * context and top actions.
 */

export function ThreadHead(props: { sceneTitle: string }) {
	const workflow = useShellWorkflowStore();
	const queueOpen = workflow.queueOpen;
	const activeRuns = workflow.activeRuns;
	const [t] = useTranslation(undefined, { i18n });
	let pillWrapRef: HTMLDivElement | undefined;

	onMount(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!queueOpen()) return;
			if (event.key === "Escape") workflow.closeQueue();
		};
		const onPointerDown = (event: PointerEvent) => {
			if (!queueOpen()) return;
			const target = event.target;
			if (pillWrapRef && (!(target instanceof Node) || !pillWrapRef.contains(target))) {
				workflow.closeQueue();
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
					onClick={workflow.toggleQueue}
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
							<For each={activeRuns()}>{(run) => <WorkRunCard run={run} />}</For>
						</Show>
					</div>
				</Show>
			</div>
		</header>
	);
}
