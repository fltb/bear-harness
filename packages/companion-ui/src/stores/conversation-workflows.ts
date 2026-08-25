import { i18n } from "@bear-harness/i18n";
import type { ResourceRefView } from "@bear-harness/protocol";
import { createEffect, createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { CompanionStore, ConfiguredModel, ConversationSummary } from "./companion.js";
export type ComposerAttachment =
	| { kind: "text"; name: string; content: string }
	| { kind: "image"; name: string; mime: string; base64: string }
	| { kind: "resource"; resource: ResourceRefView };

type ResourceBridge = {
	pickFiles(id: string): Promise<unknown>;
	pickDirectory(id: string): Promise<unknown>;
	attachDropped(id: string, files: readonly File[]): Promise<unknown>;
	detach(conversationId: string, resourceId: string): Promise<unknown>;
};
function bridge(): ResourceBridge | undefined {
	return (globalThis as typeof globalThis & { bearDesktop?: { resources?: ResourceBridge } })
		.bearDesktop?.resources;
}
function resourceViews(value: unknown): ResourceRefView[] {
	if (typeof value !== "object" || value === null || (value as { ok?: unknown }).ok !== true)
		throw new Error("resource_reference_failed");
	const resources = (value as { data?: { resources?: unknown } }).data?.resources;
	if (!Array.isArray(resources)) throw new Error("resource_reference_failed");
	return resources as ResourceRefView[];
}

/** One-shot request consumed by the settings sheet's image-reader focus effect. */
export const [requestImageReaderFocus, setRequestImageReaderFocus] = createSignal(false);

export function modelDisplayName(model: ConfiguredModel): string {
	return `${model.label} (${model.providerName ?? model.providerId})`;
}

interface ConversationWorkflowState {
	composerText: string;
	attachments: ComposerAttachment[];
	modelError: string | null;
	modelBusy: boolean;
	attachmentError: string | null;
	sendError: string | null;
	imageRouteError: boolean;
	retryingSend: boolean;
	query: string;
	editingId: string | undefined;
	editingTitle: string;
	sidebarError: string | null;
}

const workflows = new WeakMap<object, ReturnType<typeof createConversationWorkflow>>();

/** Shared workflow state for composer and sidebar surfaces of one companion store. */
export function useConversationWorkflow(store: CompanionStore) {
	const existing = workflows.get(store);
	if (existing) return existing;
	const created = createConversationWorkflow(store);
	workflows.set(store, created);
	return created;
}

function createConversationWorkflow(store: CompanionStore) {
	const [state, setState] = createStore<ConversationWorkflowState>({
		composerText: "",
		attachments: [],
		modelError: null,
		modelBusy: false,
		attachmentError: null,
		sendError: null,
		imageRouteError: false,
		retryingSend: false,
		query: "",
		editingId: undefined,
		editingTitle: "",
		sidebarError: null,
	});

	const modelApi = createMemo(() => (store as Partial<CompanionStore>).model);
	const models = createMemo<ConfiguredModel[]>(() => modelApi()?.models?.() ?? []);
	const modelData = createMemo(() => modelApi()?.data?.());
	const selectedModel = createMemo(() => {
		const route = modelData()?.selected;
		return route
			? (models().find(
					(model) => model.providerId === route.providerId && model.modelId === route.modelId,
				) ?? null)
			: null;
	});
	const modelSelected = createMemo(() => selectedModel() !== null);
	const multimodalFallback = createMemo(() => {
		const route = modelData()?.multimodalFallback;
		return route
			? models().find(
					(model) => model.providerId === route.providerId && model.modelId === route.modelId,
				)
			: undefined;
	});
	const hasImages = createMemo(() =>
		state.attachments.some((attachment) => attachment.kind === "image"),
	);
	const needsImageReader = createMemo(
		() => hasImages() && selectedModel()?.supportsImages === false,
	);
	const imageReaderCapable = createMemo(
		() => selectedModel()?.supportsImages === true || Boolean(multimodalFallback()),
	);
	const imageReaderAvailable = createMemo(
		() => !hasImages() || (!state.imageRouteError && imageReaderCapable()),
	);
	const imageReaderLabel = createMemo(() => {
		const fallback = multimodalFallback();
		return fallback
			? i18n.t("composer.imageReadBy").replace("{model}", modelDisplayName(fallback))
			: "";
	});
	const streaming = createMemo(() => store.activePiLiveState?.isStreaming === true);
	const visibleConversations = createMemo<ConversationSummary[]>(() => {
		const needle = state.query.trim().toLocaleLowerCase();
		const conversations = store.conversations ?? [];
		if (!needle) return conversations;
		return conversations.filter((conversation) =>
			`${conversation.title} ${conversation.sceneTitle}`.toLocaleLowerCase().includes(needle),
		);
	});
	const refreshModels = (conversationId: string): void => {
		const api = modelApi();
		if (api?.list) void api.list(conversationId);
	};

	const removeImages = (): void => {
		setState("attachments", (current) =>
			current.filter((attachment) => attachment.kind !== "image"),
		);
	};
	const chooseFiles = async (files: File[]): Promise<void> => {
		const loaded: ComposerAttachment[] = [];
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = "";
				for (const byte of bytes) binary += String.fromCharCode(byte);
				loaded.push({ kind: "image", name: file.name, mime: file.type, base64: btoa(binary) });
			} else {
				loaded.push({ kind: "text", name: file.name, content: await file.text() });
			}
		}
		setState("imageRouteError", false);
		setState("attachments", loaded);
	};
	const loadFiles = async (files: File[]): Promise<void> => {
		setState("attachmentError", null);
		try {
			await chooseFiles(files);
		} catch (cause) {
			setState("attachmentError", cause instanceof Error ? cause.message : String(cause));
		}
	};
	const addResources = async (kind: "file" | "directory"): Promise<void> => {
		const id = store.activeConversationId;
		const api = bridge();
		if (!id || !api) return;
		try {
			const views = resourceViews(
				kind === "file" ? await api.pickFiles(id) : await api.pickDirectory(id),
			);
			setState("attachments", (current) => [
				...current,
				...views.map((resource) => ({ kind: "resource" as const, resource })),
			]);
		} catch (cause) {
			setState("attachmentError", cause instanceof Error ? cause.message : String(cause));
		}
	};
	const attachDropped = async (files: readonly File[]): Promise<void> => {
		const id = store.activeConversationId;
		const api = bridge();
		if (!id || !api || files.length === 0) return;
		try {
			const views = resourceViews(await api.attachDropped(id, files));
			setState("attachments", (current) => [
				...current,
				...views.map((resource) => ({ kind: "resource" as const, resource })),
			]);
		} catch (cause) {
			setState("attachmentError", cause instanceof Error ? cause.message : String(cause));
		}
	};
	const removeAttachment = (index: number): void => {
		const attachment = state.attachments[index];
		const conversationId = store.activeConversationId;
		if (attachment?.kind === "resource" && conversationId)
			void bridge()?.detach(conversationId, attachment.resource.id);
		setState("attachments", (current) => current.filter((_, candidate) => candidate !== index));
	};
	const dispatchMessage = async (
		labels: { materialLabel: string; imageLabel: string },
		options?: { retry?: boolean; textOverride?: string },
	): Promise<void> => {
		const retry = options?.retry === true;
		const value = options?.textOverride ?? state.composerText;
		if (!value.trim() && state.attachments.length === 0) return;
		if (!retry && !imageReaderAvailable()) return;
		if (retry && hasImages() && !imageReaderCapable()) return;
		const draftAttachments = state.attachments;
		const materials = draftAttachments
			.filter((file): file is Extract<ComposerAttachment, { kind: "text" }> => file.kind === "text")
			.map((file) => `\n\n[${labels.materialLabel}：${file.name}]\n${file.content}`)
			.join("");
		const images = draftAttachments
			.filter((file) => file.kind === "image")
			.map((file) => ({ name: file.name, mime: file.mime, base64: file.base64 }));
		const references = draftAttachments
			.filter((item) => item.kind === "resource")
			.map(
				(item) => `\n\n[本机引用：${item.resource.displayName} · resource_id=${item.resource.id}]`,
			)
			.join("");
		const message =
			`${value}${materials}${references}`.trim() ||
			images.map((image) => `[${labels.imageLabel}：${image.name}]`).join("\n");
		const hadImages = images.length > 0;
		const before = store.errorMetadata;
		setState("sendError", null);
		setState("modelError", null);
		try {
			await store.sendMessage(message, hadImages ? images : undefined);
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) {
				setState("composerText", value);
				setState("attachments", draftAttachments);
				setState("sendError", retained.message);
				setState("retryingSend", false);
				return;
			}
			// The Pi preflight accepted the message: the draft is consumed by
			// the Pi session and the thread updates via `pi.session.changed`.
			// Accepted drafts are never replayed as messages.
			setState("retryingSend", false);
			setState("composerText", "");
			setState("attachments", []);
			setState("imageRouteError", false);
		} catch (cause) {
			setState("composerText", value);
			setState("attachments", draftAttachments);
			setState("sendError", cause instanceof Error ? cause.message : String(cause));
			setState("retryingSend", false);
		}
	};
	const retrySend = (labels: { materialLabel: string; imageLabel: string }): void => {
		if (state.retryingSend || (hasImages() && !imageReaderCapable())) return;
		setState("retryingSend", true);
		void dispatchMessage(labels, { retry: true });
	};
	const selectModel = async (model: ConfiguredModel | null): Promise<void> => {
		const conversationId = store.activeConversationId;
		const api = modelApi();
		if (!conversationId || !model || state.modelBusy || !api?.select || !api.setDefaultReply)
			return;
		setState("modelError", null);
		setState("sendError", null);
		setState("modelBusy", true);
		const before = store.errorMetadata;
		try {
			await Promise.all([
				api.select(conversationId, model.providerId, model.modelId),
				api.setDefaultReply(model.providerId, model.modelId),
			]);
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) setState("modelError", retained.message);
		} catch (cause) {
			setState("modelError", cause instanceof Error ? cause.message : String(cause));
		} finally {
			setState("modelBusy", false);
		}
	};

	const runSidebarAction = async (action: () => Promise<void>): Promise<void> => {
		setState("sidebarError", null);
		const before = store.errorMetadata;
		try {
			await action();
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) setState("sidebarError", retained.message);
		} catch (cause) {
			setState("sidebarError", cause instanceof Error ? cause.message : String(cause));
		}
	};
	const beginRename = (conversation: ConversationSummary): void => {
		setState("editingTitle", conversation.title);
		setState("editingId", conversation.id);
	};
	const saveRename = async (conversationId: string): Promise<void> => {
		const title = state.editingTitle.trim();
		if (!title) return;
		await runSidebarAction(async () => {
			await store.renameConversation(conversationId, title);
			setState("editingId", undefined);
		});
	};

	return {
		state,
		composerText: () => state.composerText,
		setComposerText: (value: string) => setState("composerText", value),
		attachments: () => state.attachments,
		setAttachmentError: (value: string | null) => setState("attachmentError", value),
		modelError: () => state.modelError,
		modelBusy: () => state.modelBusy,
		attachmentError: () => state.attachmentError,
		sendError: () => state.sendError,
		imageRouteError: () => state.imageRouteError,
		retryingSend: () => state.retryingSend,
		query: () => state.query,
		setQuery: (value: string) => setState("query", value),
		editingId: () => state.editingId,
		editingTitle: () => state.editingTitle,
		setEditingTitle: (value: string) => setState("editingTitle", value),
		sidebarError: () => state.sidebarError,
		refreshModels,
		models,
		modelSelected,
		selectedModel,
		multimodalFallback,
		hasImages,
		needsImageReader,
		imageReaderAvailable,
		imageReaderLabel,
		streaming,
		visibleConversations,
		removeImages,
		loadFiles,
		addResources,
		attachDropped,
		removeAttachment,
		dispatchMessage,
		retrySend,
		selectModel,
		runSidebarAction,
		beginRename,
		saveRename,
		setImageRouteError: (value: boolean) => setState("imageRouteError", value),
		setSendError: (value: string | null) => setState("sendError", value),
	};
}
export function useConversationViewWorkflow(store: CompanionStore) {
	const workflow = useConversationWorkflow(store);
	const sceneTitle = createMemo(
		() =>
			(store.conversations ?? []).find(
				(conversation) => conversation.id === store.activeConversationId,
			)?.sceneTitle ??
			store.character?.character.scene_title ??
			"",
	);
	const hasThreadContent = createMemo(
		() =>
			(store.activePiTimeline?.entries.length ?? 0) > 0 ||
			store.activePiLiveState?.streamingMessage !== undefined,
	);
	const roleplayChoiceSet = createMemo(() =>
		store.character?.roleplay.choice_sets?.find(
			(entry) => entry.id === store.activeRoleplayChoiceSetId,
		),
	);
	const roleplayInlineMedia = createMemo(() => {
		const item = store.character?.roleplay.media.find(
			(entry) => entry.id === store.activeRoleplayMediaId,
		);
		return item && item.presentation === "inline" ? item : undefined;
	});
	const roleplayOverlayMedia = createMemo(() => {
		const item = store.character?.roleplay.media.find(
			(entry) => entry.id === store.activeRoleplayMediaId,
		);
		return item && item.presentation !== "inline" && item.presentation !== "ambient"
			? item
			: undefined;
	});
	const roleplayAmbientMedia = createMemo(() => {
		const item = store.character?.roleplay.media.find(
			(entry) => entry.id === store.activeAmbientMediaId,
		);
		return item && item.kind === "audio" && item.presentation === "ambient" ? item : undefined;
	});
	return {
		...workflow,
		sceneTitle,
		hasThreadContent,
		roleplayChoiceSet,
		roleplayInlineMedia,
		roleplayOverlayMedia,
		roleplayAmbientMedia,
	};
}
