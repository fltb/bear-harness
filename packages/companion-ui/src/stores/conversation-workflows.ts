import { i18n } from "@bear-harness/i18n";
import type { Accessor } from "solid-js";
import { createEffect, createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type {
	CharacterDisplay,
	CompanionStore,
	ConfiguredModel,
	ConversationSummary,
	Message,
	MessageVersion,
} from "./companion.js";
export type ComposerAttachment =
	| { kind: "text"; name: string; content: string }
	| { kind: "image"; name: string; mime: string; base64: string };

type Translate = (key: string) => string;
type CorrectScope = "once" | "session" | "always";

/** One-shot request consumed by the settings sheet's image-reader focus effect. */
export const [requestImageReaderFocus, setRequestImageReaderFocus] = createSignal(false);

export function modelDisplayName(model: ConfiguredModel): string {
	return `${model.label} (${model.providerName ?? model.providerId})`;
}

function formatMessageTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return i18n.t("messages.justNow");
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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
	const selectedModelValue = createMemo(() => modelApi()?.selectedValue?.() ?? "");
	const modelData = createMemo(() => modelApi()?.data?.());
	const modelSelected = createMemo(() => selectedModelValue().length > 0);
	const selectedModel = createMemo(
		() => models().find((model) => `${model.providerId}:${model.modelId}` === selectedModelValue()) ?? null,
	);
	const multimodalFallback = createMemo(() => {
		const route = modelData()?.multimodalFallback;
		return route
			? models().find((model) => model.providerId === route.providerId && model.modelId === route.modelId)
			: undefined;
	});
	const hasImages = createMemo(() => state.attachments.some((attachment) => attachment.kind === "image"));
	const needsImageReader = createMemo(() => hasImages() && selectedModel()?.supportsImages === false);
	const imageReaderAvailable = createMemo(
		() => !hasImages() || (!state.imageRouteError && (!needsImageReader() || Boolean(multimodalFallback()))),
	);
	const imageReaderLabel = createMemo(() => {
		const fallback = multimodalFallback();
		return fallback ? i18n.t("composer.imageReadBy").replace("{model}", modelDisplayName(fallback)) : "";
	});
	const streamingAssistantText = createMemo(() => store.streamingAssistantText ?? "");
	const streaming = createMemo(
		() =>
			store.assistantStreaming ||
			(store.pendingUserText !== undefined &&
				state.sendError === null &&
				!(state.imageRouteError && !hasImages())) ||
			streamingAssistantText().length > 0,
	);
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
		setState("attachments", (current) => current.filter((attachment) => attachment.kind !== "image"));
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
	const dispatchMessage = async (
		labels: { materialLabel: string; imageLabel: string },
		options?: { retry?: boolean },
	): Promise<void> => {
		const retry = options?.retry === true;
		const value = state.composerText;
		if (!value.trim() && state.attachments.length === 0) return;
		if (!retry && !imageReaderAvailable()) return;
		if (retry && needsImageReader() && !multimodalFallback()) return;
		const draftAttachments = state.attachments;
		const materials = draftAttachments
			.filter((file): file is Extract<ComposerAttachment, { kind: "text" }> => file.kind === "text")
			.map((file) => `\n\n[${labels.materialLabel}：${file.name}]\n${file.content}`)
			.join("");
		const images = draftAttachments
			.filter((file) => file.kind === "image")
			.map((file) => ({ name: file.name, mime: file.mime, base64: file.base64 }));
		const message =
			`${value}${materials}`.trim() || images.map((image) => `[${labels.imageLabel}：${image.name}]`).join("\n");
		const hadImages = images.length > 0;
		const before = store.errorMetadata;
		setState("sendError", null);
		setState("modelError", null);
		if (!retry) {
			setState("composerText", "");
			setState("attachments", []);
		}
		try {
			await store.sendMessage(message, hadImages ? images : undefined);
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) {
				setState("composerText", value);
				setState("attachments", draftAttachments);
				if (hadImages && store.pendingUserText !== undefined) setState("imageRouteError", true);
				else setState("sendError", retained.message);
				setState("retryingSend", false);
				return;
			}
			setState("retryingSend", false);
			if (hadImages && store.pendingUserText !== undefined) {
				setState("composerText", value);
				setState("attachments", draftAttachments);
				setState("imageRouteError", true);
				return;
			}
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
		if (state.retryingSend || (needsImageReader() && !multimodalFallback())) return;
		setState("retryingSend", true);
		void dispatchMessage(labels, { retry: true });
	};
	const selectModel = async (model: ConfiguredModel | null): Promise<void> => {
		const conversationId = store.activeConversationId;
		const api = modelApi();
		if (!conversationId || !model || state.modelBusy || !api?.select) return;
		setState("modelError", null);
		setState("sendError", null);
		setState("modelBusy", true);
		const before = store.errorMetadata;
		try {
			await api.select(conversationId, model.providerId, model.modelId);
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

export function useConversationViewWorkflow(
	store: CompanionStore,
	character: Accessor<CharacterDisplay | undefined>,
) {
	const workflow = useConversationWorkflow(store);
	const sceneTitle = createMemo(
		() =>
			(store.conversations ?? []).find((conversation) => conversation.id === store.activeConversationId)?.sceneTitle ??
			character()?.character.scene_title ??
			"",
	);
	const visibleMessages = createMemo(() =>
		(store.activeMessages ?? []).filter((message) => message.role === "user" || message.role === "assistant"),
	);
	const lastAssistant = createMemo(() => visibleMessages().at(-1));
	const lastAssistantId = createMemo(() => {
		const last = lastAssistant();
		return last?.role === "assistant" ? last.id : null;
	});
	const streamedAssistantText = createMemo(() => store.streamingAssistantText ?? "");
	const streamedContent = createMemo(() => {
		const draft = streamedAssistantText();
		if (draft.length === 0) return "";
		const last = lastAssistant();
		if (!last || last.role !== "assistant") return draft;
		const lastAdopted = last.versions.at(-1)?.content ?? "";
		return lastAdopted.trim() === draft.trim() ? "" : draft;
	});
	const hasThreadContent = createMemo(
		() =>
			visibleMessages().length > 0 ||
			store.pendingUserText !== undefined ||
			store.assistantStreaming ||
			streamedAssistantText().length > 0,
	);
	const roleplayChoiceSet = createMemo(() =>
		character()?.roleplay.choice_sets?.find((entry) => entry.id === store.activeRoleplayChoiceSetId),
	);
	const roleplayInlineMedia = createMemo(() => {
		const item = character()?.roleplay.media.find((entry) => entry.id === store.activeRoleplayMediaId);
		return item && item.presentation === "inline" ? item : undefined;
	});
	const roleplayOverlayMedia = createMemo(() => {
		const item = character()?.roleplay.media.find((entry) => entry.id === store.activeRoleplayMediaId);
		return item && item.presentation !== "inline" && item.presentation !== "ambient" ? item : undefined;
	});
	const roleplayAmbientMedia = createMemo(() => {
		const item = character()?.roleplay.media.find((entry) => entry.id === store.activeAmbientMediaId);
		return item && item.kind === "audio" && item.presentation === "ambient" ? item : undefined;
	});
	return {
		...workflow,
		sceneTitle,
		visibleMessages,
		lastAssistant,
		lastAssistantId,
		streamedContent,
		hasThreadContent,
		roleplayChoiceSet,
		roleplayInlineMedia,
		roleplayOverlayMedia,
		roleplayAmbientMedia,
	};
}

export function createMessageWorkflow(
	store: CompanionStore,
	message: Accessor<Message>,
	characterName: Accessor<string>,
	correction: Accessor<CharacterDisplay["character"]["correction"]>,
	translate: Translate,
) {
	const [state, setState] = createStore({
		editing: false,
		actionsOpen: false,
		editText: "",
		correcting: false,
		reason: "",
		customReason: "",
		scope: "once" as CorrectScope,
		captureStatus: "idle" as "idle" | "success",
		actionBusy: false,
		actionError: null as string | null,
	});
	const isUser = createMemo(() => message().role === "user");
	const version = createMemo<MessageVersion | undefined>(() => {
		const current = message();
		if (current.adoptedVersionId !== undefined) {
			const byId = current.versions.find((candidate) => candidate.id === current.adoptedVersionId);
			if (byId) return byId;
		}
		return current.versions.find((candidate) => candidate.adopted) ?? current.versions.at(-1);
	});
	const content = createMemo(() => version()?.content ?? "");
	const versionIndex = createMemo(() => message().versions.findIndex((candidate) => candidate.id === (version()?.id ?? "")));
	const meta = createMemo(() =>
		isUser() ? translate("messages.userMeta") : `${characterName()} · ${formatMessageTime(message().createdAt)}`,
	);
	const correctionReasons = createMemo(() => [
		translate("messages.correctionReasons.tone"),
		translate("messages.correctionReasons.identity"),
		translate("messages.correctionReasons.history"),
		translate("messages.correctionReasons.userAction"),
		translate("messages.correctionReasons.fictionReality"),
	]);
	const runAction = async (action: () => Promise<unknown>): Promise<boolean> => {
		setState("actionBusy", true);
		setState("actionError", null);
		setState("captureStatus", "idle");
		const before = store.errorMetadata;
		try {
			await action();
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) {
				setState("actionError", retained.message);
				return false;
			}
			return true;
		} catch (cause) {
			setState("actionError", cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setState("actionBusy", false);
		}
	};
	const switchTo = (index: number): void => {
		const target = message().versions[index];
		if (target) void runAction(() => store.switchVersion(message().id, target.id));
	};
	const startEdit = (): void => {
		setState("actionError", null);
		setState("captureStatus", "idle");
		setState("editText", content());
		setState("actionsOpen", false);
		setState("editing", true);
	};
	const saveEdit = async (): Promise<void> => {
		const text = state.editText.trim();
		if (!text || state.actionBusy) return;
		const ok = await runAction(() => store.editMessage(message().id, text, isUser()));
		if (ok) setState("editing", false);
	};
	const submitCorrect = (): void => {
		const text = state.reason || state.customReason.trim();
		if (!text || state.actionBusy) return;
		void runAction(() => store.correctMessage(text, state.scope)).then((ok) => {
			if (!ok) return;
			setState("reason", "");
			setState("customReason", "");
			setState("correcting", false);
		});
	};
	const captureMoment = async (): Promise<void> => {
		if (state.actionBusy) return;
		const ok = await runAction(() => store.memory.capture(message().id));
		if (ok) setState("captureStatus", "success");
	};
	return {
		isUser,
		version,
		content,
		versionIndex,
		meta,
		correction,
		correctionReasons,
		editing: () => state.editing,
		actionsOpen: () => state.actionsOpen,
		editText: () => state.editText,
		correcting: () => state.correcting,
		reason: () => state.reason,
		customReason: () => state.customReason,
		scope: () => state.scope,
		captureStatus: () => state.captureStatus,
		actionBusy: () => state.actionBusy,
		actionError: () => state.actionError,
		setActionError: (value: string | null) => setState("actionError", value),
		setActionsOpen: (value: boolean) => setState("actionsOpen", value),
		setEditText: (value: string) => setState("editText", value),
		setCorrecting: (value: boolean) => setState("correcting", value),
		setReason: (value: string) => setState("reason", value),
		setCustomReason: (value: string) => setState("customReason", value),
		setScope: (value: CorrectScope) => setState("scope", value),
		setEditing: (value: boolean) => setState("editing", value),
		switchTo,
		startEdit,
		saveEdit,
		submitCorrect,
		captureMoment,
		runAction,
	};
}
