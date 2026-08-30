import { i18n, useTranslation } from "@bear-harness/i18n";
import { faSliders } from "@fortawesome/free-solid-svg-icons";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ConversationStatePanel } from "./ConversationStatePanel.js";
import { Icon } from "./Icon.js";
import { useShellWorkflowStore } from "./stores/shell-workflows.js";
import { Button } from "./ui/primitives.js";
import { WorkRunCard } from "./WorkPanel.js";

/**
 * Thread head: the current scene title and the "进行中的事" work pill
 * (live run count from the store, opens the run queue). The OS window
 * frame provides the real title bar, so this header only carries thread
 * context and top actions.
 */

export function ThreadHead(props: { sceneLabel: string }) {
	const workflow = useShellWorkflowStore();
	const queueOpen = workflow.queueOpen;
	const activeRuns = workflow.activeRuns;
	const [t] = useTranslation(undefined, { i18n });
	const [stateOpen, setStateOpen] = createSignal(false);
	const activeCharacterState = createMemo(() => {
		const conversationId = workflow.host.activeConversationId;
		return conversationId
			? workflow.host.companionState?.byConversation[conversationId]?.character
			: undefined;
	});
	const labels = createMemo(() => workflow.character()?.character.work_presentation?.labels);
	const recentRuns = createMemo(() =>
		workflow.host.runs.filter(
			(run) =>
				run.conversationId === workflow.host.activeConversationId &&
				!activeRuns().some((activeRun) => activeRun.id === run.id),
		),
	);
	let wrapper: HTMLDivElement | undefined;

	onMount(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!queueOpen()) return;
			if (event.key === "Escape") workflow.closeQueue();
		};
		const onPointerDown = (event: PointerEvent) => {
			if (!queueOpen() || wrapper?.contains(event.target as Node)) return;
			workflow.closeQueue();
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
			<h1 class="scene-title">{props.sceneLabel}</h1>
			<Show when={activeCharacterState()}>
				<Button
					type="button"
					class="conversation-state-trigger"
					aria-label={t("threadHead.conversationState")}
					title={t("threadHead.conversationState")}
					onClick={() => setStateOpen(true)}
				>
					<Icon icon={faSliders} />
					<span>{t("threadHead.conversationState")}</span>
				</Button>
			</Show>
			<div class="work-pill-wrap" ref={wrapper}>
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
							<For each={activeRuns()}>{(run) => <WorkRunCard run={run} labels={labels()} />}</For>
						</Show>
						<Show when={recentRuns().length > 0}>
							<h3>{t("threadHead.recentWork")}</h3>
							<For each={recentRuns()}>{(run) => <WorkRunCard run={run} labels={labels()} />}</For>
						</Show>
					</div>
				</Show>
			</div>
			<ConversationStatePanel open={stateOpen()} onOpenChange={setStateOpen} />
		</header>
	);
}
