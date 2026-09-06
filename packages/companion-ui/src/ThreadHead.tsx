import { i18n, useTranslation } from "@bear-harness/i18n";
import { faSliders } from "@fortawesome/free-solid-svg-icons";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { ConversationStatePanel } from "./ConversationStatePanel.js";
import { Icon } from "./Icon.js";
import { RunTaskPanel } from "./RunTaskPanel.js";
import { useShellWorkflowStore } from "./stores/shell-workflows.js";
import { Button } from "./ui/primitives.js";

/**
 * Thread head: current scene and external-task queue. Pi conversation execution
 * is shown separately in the thread, not counted as an external task. The OS window
 * frame provides the real title bar, so this header only carries thread
 * context and top actions.
 */

export function ThreadHead(props: { sceneLabel: string }) {
	const workflow = useShellWorkflowStore();
	const queueOpen = workflow.queueOpen;
	const activeRuns = workflow.activeRuns;
	const [t] = useTranslation(undefined, { i18n });
	const [stateOpen, setStateOpen] = createSignal(false);
	const activeCharacterState = createMemo(() => workflow.host.companionState?.state.character);
	let wrapper: HTMLDivElement | undefined;
	let queueTrigger: HTMLButtonElement | undefined;
	let conversationStateTrigger: HTMLButtonElement | undefined;
	let panel: HTMLElement | undefined;
	const closeQueue = () => {
		workflow.closeQueue();
		if (queueTrigger?.isConnected) queueTrigger.focus();
	};
	const setConversationStateOpen = (open: boolean) => {
		setStateOpen(open);
		if (!open) {
			queueMicrotask(() => {
				if (conversationStateTrigger?.isConnected) conversationStateTrigger.focus();
			});
		}
	};

	onMount(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!queueOpen() || event.key !== "Escape") return;
			event.preventDefault();
			closeQueue();
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
					ref={(element) => {
						conversationStateTrigger = element;
					}}
					type="button"
					class="conversation-state-trigger"
					aria-label={t("threadHead.conversationState")}
					title={t("threadHead.conversationState")}
					onClick={() => setConversationStateOpen(true)}
				>
					<Icon icon={faSliders} />
					<span>{t("threadHead.conversationState")}</span>
				</Button>
			</Show>
			<div class="work-pill-wrap" ref={wrapper}>
				<Button
					ref={(element) => {
						queueTrigger = element;
					}}
					type="button"
					class="work-pill"
					aria-expanded={queueOpen()}
					aria-controls="current-work-panel"
					onClick={workflow.toggleQueue}
				>
					<Show when={activeRuns().length > 0}>
						<span class="pulse" aria-hidden="true" />
					</Show>
					{t("threadHead.runningWork")}
					<b>{activeRuns().length}</b>
				</Button>
				<Show when={queueOpen()}>
					<section
						ref={(element) => {
							panel = element;
							onMount(() => {
								if (!workflow.selectedTaskId() && element.isConnected) element.focus();
							});
						}}
						id="current-work-panel"
						class="queue-pop task-workspace"
						tabIndex={-1}
						aria-label={t("threadHead.runningWork")}
					>
						<div class="task-panel-heading">
							<h2>{t("threadHead.runningWork")}</h2>
							<Button type="button" onClick={closeQueue}>
								{t("work.task.close")}
							</Button>
						</div>
						<RunTaskPanel onBack={() => panel?.isConnected && panel.focus()} />
					</section>
				</Show>
			</div>
			<ConversationStatePanel open={stateOpen()} onOpenChange={setConversationStateOpen} />
		</header>
	);
}
