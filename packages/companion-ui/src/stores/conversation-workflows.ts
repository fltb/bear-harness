import { createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { CompanionStore, ConfiguredModel, ConversationSummary } from "./companion.js";

interface State {
	composerDrafts: Record<string, string>;
	query: string;
	editingId?: string;
	editingTitle: string;
	renameRequired: boolean;
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
	const [modelBusySessions, setModelBusySessions] = createSignal<ReadonlySet<string>>(new Set());
	const submitting = new Set<string>();
	const [state, setState] = createStore<State>({
		composerDrafts: {},
		query: "",
		editingTitle: "",
		renameRequired: false,
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
	const runSidebarAction = async (action: () => Promise<void>): Promise<boolean> => {
		setState("sidebarError", null);
		try {
			await action();
			return true;
		} catch (cause) {
			setState("sidebarError", cause instanceof Error ? cause.message : String(cause));
			return false;
		}
	};
	const activeDraft = () => {
		const conversationId = store.activeConversationId;
		return conversationId ? (state.composerDrafts[conversationId] ?? "") : "";
	};
	const setActiveDraft = (value: string) => {
		const conversationId = store.activeConversationId;
		if (conversationId) setState("composerDrafts", conversationId, value);
	};
	const forgetDraft = (conversationId: string) =>
		setState("composerDrafts", (current) => {
			if (!(conversationId in current)) return current;
			const next = { ...current };
			delete next[conversationId];
			return next;
		});
	return {
		composerText: activeDraft,
		setComposerText: setActiveDraft,
		forgetDraft,
		insertLocalPaths: (paths: readonly string[], label: string) => {
			if (paths.length === 0) return;
			const references = paths.map((path) => `${label}：${JSON.stringify(path)}`).join("\n");
			const draft = activeDraft();
			setActiveDraft(`${draft.trimEnd()}${draft ? "\n\n" : ""}${references}`);
		},
		modelBusy: () => modelBusySessions().has(store.activeConversationId ?? ""),
		query: () => state.query,
		setQuery,
		visibleConversations: () => store.conversations,
		editingId: () => state.editingId,
		editingTitle: () => state.editingTitle,
		setEditingTitle: (value: string) => {
			setState("editingTitle", value);
			setState("renameRequired", false);
		},
		renameRequired: () => state.renameRequired,
		sidebarError: () => state.sidebarError,
		beginRename: (conversation: ConversationSummary) => {
			setState("editingId", conversation.conversationId);
			setState("editingTitle", conversation.name ?? conversation.firstMessage);
			setState("renameRequired", false);
		},
		cancelRename: () => {
			setState("editingId", undefined);
			setState("editingTitle", "");
			setState("renameRequired", false);
		},
		saveRename: async (id: string): Promise<boolean> => {
			const title = state.editingTitle.trim();
			if (!title) {
				setState("renameRequired", true);
				return false;
			}
			setState("renameRequired", false);
			const saved = await runSidebarAction(() => store.renameConversation(id, title));
			if (!saved) return false;
			setState("editingId", undefined);
			setState("editingTitle", "");
			return true;
		},
		runSidebarAction,
		sceneLabel,
		models,
		selectedModel,
		modelSelected: () => selectedModel() !== null,
		refreshModels: (id: string) => void store.model.list(id),
		selectModel: async (model: ConfiguredModel | null) => {
			const id = store.activeConversationId;
			if (!model || !id || modelBusySessions().has(id)) return;
			setModelBusySessions((current) => new Set(current).add(id));
			try {
				await store.model.select(id, model.providerId, model.modelId);
			} catch {
				// The store exposes the failed operation once; the composer must not mirror it.
			} finally {
				setModelBusySessions((current) => {
					const next = new Set(current);
					next.delete(id);
					return next;
				});
			}
		},
		dispatchMessage: async () => {
			const conversationId = store.activeConversationId;
			const message = activeDraft().trim();
			if (
				!conversationId ||
				!message ||
				submitting.has(conversationId) ||
				store.conversationMutationBusy
			)
				return;
			submitting.add(conversationId);
			const previousSubmission = store.activeSubmission?.id;
			try {
				const sending = store.sendMessage(message);
				// Clear only after the store staged this request. A synchronous
				// pre-dispatch rejection must leave the unsent form draft untouched.
				if (
					store.activeSubmission?.id !== previousSubmission &&
					store.activeSubmission?.conversationId === conversationId
				)
					setState("composerDrafts", conversationId, "");
				await sending;
			} catch {
				// Dispatched request failures remain available in submission feedback.
			} finally {
				submitting.delete(conversationId);
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
		hasThreadContent: () => store.activeTimeline.length > 0,
	};
}
