import { createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import type { CompanionStore, ConfiguredModel, ConversationSummary } from "./companion.js";

interface State {
	composerText: string;
	modelBusy: boolean;
	query: string;
	editingId?: string;
	editingTitle: string;
	sidebarError: string | null;
}

const instances = new WeakMap<CompanionStore, ReturnType<typeof createWorkflow>>();
export function useConversationWorkflow(store: CompanionStore) {
	const existing = instances.get(store);
	if (existing) return existing;
	const value = createWorkflow(store);
	instances.set(store, value);
	return value;
}

function createWorkflow(store: CompanionStore) {
	let submitting = false;
	const [state, setState] = createStore<State>({
		composerText: "",
		modelBusy: false,
		query: "",
		editingTitle: "",
		sidebarError: null,
	});
	const models = createMemo(() => store.model.models());
	const selectedModel = createMemo(() => {
		const selected = store.model.data().selected;
		return selected
			? (models().find(
					(item) => item.providerId === selected.providerId && item.modelId === selected.modelId,
				) ?? null)
			: null;
	});
	const sceneLabel = (conversationId: string) => {
		const sceneId =
			(conversationId === store.activeConversationId
				? store.companionState?.state.display.sceneId
				: undefined) ?? store.character?.visual.defaultSceneId;
		return store.character?.scenes.find((scene) => scene.id === sceneId)?.label ?? "";
	};
	const setQuery = (value: string) => {
		setState("query", value);
		void store.searchConversations(value);
	};
	const runSidebarAction = async (action: () => Promise<void>) => {
		setState("sidebarError", null);
		try {
			await action();
		} catch (cause) {
			setState("sidebarError", cause instanceof Error ? cause.message : String(cause));
		}
	};
	return {
		composerText: () => state.composerText,
		setComposerText: (value: string) => setState("composerText", value),
		insertLocalPaths: (paths: readonly string[], label: string) => {
			if (paths.length === 0) return;
			const references = paths.map((path) => `${label}：${JSON.stringify(path)}`).join("\n");
			setState(
				"composerText",
				`${state.composerText.trimEnd()}${state.composerText ? "\n\n" : ""}${references}`,
			);
		},
		modelBusy: () => state.modelBusy,
		query: () => state.query,
		setQuery,
		visibleConversations: () => store.conversations,
		editingId: () => state.editingId,
		editingTitle: () => state.editingTitle,
		setEditingTitle: (value: string) => setState("editingTitle", value),
		sidebarError: () => state.sidebarError,
		beginRename: (conversation: ConversationSummary) => {
			setState("editingId", conversation.conversationId);
			setState("editingTitle", conversation.name ?? conversation.firstMessage);
		},
		saveRename: async (id: string) => {
			const title = state.editingTitle.trim();
			if (!title) return;
			await runSidebarAction(async () => {
				await store.renameConversation(id, title);
				setState("editingId", undefined);
			});
		},
		runSidebarAction,
		sceneLabel,
		models,
		selectedModel,
		modelSelected: () => selectedModel() !== null,
		streaming: () => store.activePiLiveState?.isStreaming === true,
		refreshModels: (id: string) => void store.model.list(id),
		selectModel: async (model: ConfiguredModel | null) => {
			const id = store.activeConversationId;
			if (!model || !id) return;
			setState("modelBusy", true);
			try {
				await store.model.select(id, model.providerId, model.modelId);
			} catch {
				// The store exposes the failed operation once; the composer must not mirror it.
			} finally {
				setState("modelBusy", false);
			}
		},
		dispatchMessage: async () => {
			const message = state.composerText.trim();
			if (!message || submitting) return;
			submitting = true;
			setState("composerText", "");
			try {
				await store.sendMessage(message);
			} catch {
			} finally {
				submitting = false;
			}
		},
	};
}

export function useConversationViewWorkflow(store: CompanionStore) {
	const workflow = useConversationWorkflow(store);
	return {
		...workflow,
		submitText: (text: string) => store.sendMessage(text),
		sceneLabel: () =>
			store.activeConversationId ? workflow.sceneLabel(store.activeConversationId) : "",
		hasThreadContent: () =>
			store.activeTimeline.length > 0,
	};
}
