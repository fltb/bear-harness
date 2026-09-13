import { i18n, useTranslation } from "@bear-harness/i18n";
import { faSliders } from "@fortawesome/free-solid-svg-icons";
import { createMemo, createSignal, Show } from "solid-js";
import { ConversationStatePanel } from "./ConversationStatePanel.js";
import { Icon } from "./Icon.js";
import { RunTaskPanel } from "./RunTaskPanel.js";
import { useShellWorkflowStore } from "./stores/shell-workflows.js";
import { Button, Dialog } from "./ui/primitives.js";

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
	let queueTrigger: HTMLButtonElement | undefined;
	let conversationStateTrigger: HTMLButtonElement | undefined;
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
			<div class="work-pill-wrap">
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
				<Dialog
					open={queueOpen()}
					onOpenChange={(open) => {
						if (!open) closeQueue();
					}}
				>
					<Dialog.Portal>
						<Dialog.Overlay class="task-workspace-overlay" />
						<Dialog.Content id="current-work-panel" class="task-workspace">
							<header class="task-panel-heading">
								<div>
									<Dialog.Title>{t("work.activity.workspace")}</Dialog.Title>
									<Dialog.Description>{t("work.activity.description")}</Dialog.Description>
								</div>
								<Button type="button" onClick={closeQueue}>
									{t("work.task.close")}
								</Button>
							</header>
							<div class="task-workspace-scroll">
								<RunTaskPanel />
							</div>
						</Dialog.Content>
					</Dialog.Portal>
				</Dialog>
			</div>
			<ConversationStatePanel open={stateOpen()} onOpenChange={setConversationStateOpen} />
		</header>
	);
}
