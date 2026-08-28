import { createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import type { CompanionStore, ConfiguredModel, ConversationSummary } from "./companion.js";
export interface AttachmentUploadRoot {
	kind: "file" | "folder";
	name: string;
	entries: Array<{
		entryKind: "file" | "directory";
		relativePath: string;
		file?: File;
		mime?: string;
		bytes?: number;
	}>;
}

export type ComposerAttachment = {
	kind: "attachment";
	draftId: string;
	conversationId: string;
	id?: string;
	name: string;
	attachmentKind: "file" | "folder" | "generated";
	bytes: number;
	fileCount: number;
	uploadState: "uploading" | "complete" | "error" | "cancelled";
	progress: number;
	error?: string;
	uploadId?: string;
	source?: AttachmentUploadRoot;
};

interface ConversationWorkflowState {
	composerText: string;
	attachments: ComposerAttachment[];
	modelError: string | null;
	modelBusy: boolean;
	attachmentError: string | null;
	sendError: string | null;
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
		query: "",
		editingId: undefined,
		editingTitle: "",
		sidebarError: null,
	});

	const uploads = store.attachments?.observeUploads?.(() => store.activeConversationId);
	const attachments = createMemo<ComposerAttachment[]>(() => {
		const conversationId = store.activeConversationId;
		const remoteUploads = uploads?.data()?.uploads ?? [];
		const local = state.attachments
			.filter((draft) => draft.conversationId === conversationId)
			.map((draft) => {
				const saved = draft.id ? store.attachments.data(conversationId!, draft.id) : undefined;
				const uploading = remoteUploads.find((upload) => upload.uploadId === draft.uploadId);
				return {
					...draft,
					...(saved
						? {
								name: saved.name,
								attachmentKind: saved.kind,
								bytes: saved.bytes,
								fileCount: saved.fileCount,
							}
						: {}),
					...(uploading
						? {
								progress:
									uploading.totalBytes === 0 ? 0 : uploading.receivedBytes / uploading.totalBytes,
							}
						: {}),
				};
			});
		const remoteBelongsToLocalDraft = (upload: (typeof remoteUploads)[number]) =>
			local.some(
				(draft) =>
					draft.uploadId === upload.uploadId ||
					(!draft.uploadId &&
						draft.name === upload.name &&
						draft.attachmentKind === upload.kind &&
						draft.bytes === upload.totalBytes &&
						draft.fileCount === upload.fileCount),
			);
		return [
			...local,
			...remoteUploads
				.filter((upload) => !remoteBelongsToLocalDraft(upload))
				.map((upload) => ({
					kind: "attachment" as const,
					draftId: upload.uploadId,
					conversationId: conversationId!,
					uploadId: upload.uploadId,
					name: upload.name,
					attachmentKind: upload.kind,
					bytes: upload.totalBytes,
					fileCount: upload.fileCount,
					uploadState: "uploading" as const,
					progress: upload.totalBytes === 0 ? 0 : upload.receivedBytes / upload.totalBytes,
				})),
		];
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

	const binaryBase64 = (bytes: Uint8Array): string => {
		let binary = "";
		for (let start = 0; start < bytes.byteLength; start += 32_768)
			binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
		return btoa(binary);
	};
	const uploadRoot = async (
		draftId: string,
		root: AttachmentUploadRoot,
		conversationId: string,
	): Promise<void> => {
		const files = root.entries.flatMap((entry, fileIndex) =>
			entry.entryKind === "file" && entry.file !== undefined ? [{ entry, fileIndex }] : [],
		);
		setState("attachments", (draft) => draft.draftId === draftId, {
			uploadState: "uploading",
			progress: 0,
			error: undefined,
		});
		const { uploadId } = await store.attachments.startUpload({
			conversationId,
			kind: root.kind,
			name: root.name,
			entries: root.entries.map(({ entryKind, relativePath, mime, bytes }) => ({
				entryKind,
				relativePath,
				...(mime ? { mime } : {}),
				...(bytes !== undefined ? { bytes } : {}),
			})),
		});
		setState("attachments", (drafts) =>
			drafts.map((draft) => (draft.draftId === draftId ? { ...draft, uploadId } : draft)),
		);
		try {
			for (const { entry, fileIndex } of files) {
				const file = entry.file!;
				for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
					const current = state.attachments.find((draft) => draft.draftId === draftId);
					if (!current || current.uploadState === "cancelled") {
						await store.attachments
							.cancelUpload({ conversationId, uploadId })
							.catch(() => undefined);
						return;
					}
					const chunk = new Uint8Array(
						await file.slice(offset, offset + 1024 * 1024).arrayBuffer(),
					);
					await store.attachments.appendChunk({
						conversationId,
						uploadId,
						fileIndex,
						offset,
						base64: binaryBase64(chunk),
					});
				}
			}
			const { attachment } = await store.attachments.completeUpload({ conversationId, uploadId });
			await store.attachments.list(conversationId, attachment.id);
			setState("attachments", (draft) => draft.draftId === draftId, {
				id: attachment.id,
				uploadState: "complete",
				progress: 1,
				uploadId: undefined,
			});
		} catch (cause) {
			await store.attachments.cancelUpload({ conversationId, uploadId }).catch(() => undefined);
			setState("attachments", (draft) => draft.draftId === draftId, {
				uploadState: "error",
				error: cause instanceof Error ? cause.message : String(cause),
				uploadId: undefined,
			});
		}
	};
	const uploadRoots = async (roots: AttachmentUploadRoot[]): Promise<void> => {
		const conversationId = store.activeConversationId;
		if (!conversationId) throw new Error("conversation_not_selected");
		setState("attachmentError", null);
		for (const root of roots) {
			const draftId = crypto.randomUUID();
			setState("attachments", (drafts) => [
				...drafts,
				{
					kind: "attachment",
					draftId,
					conversationId,
					name: root.name,
					attachmentKind: root.kind,
					bytes: root.entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
					fileCount: root.entries.filter((entry) => entry.entryKind === "file").length,
					uploadState: "uploading",
					progress: 0,
					source: root,
				},
			]);
			void uploadRoot(draftId, root, conversationId).catch((cause) =>
				setState("attachments", (draft) => draft.draftId === draftId, {
					uploadState: "error",
					error: cause instanceof Error ? cause.message : String(cause),
				}),
			);
		}
	};
	const loadFiles = async (files: File[]): Promise<void> => {
		await uploadRoots(
			files.map((file) => ({
				kind: "file",
				name: file.name,
				entries: [
					{
						entryKind: "file",
						relativePath: file.name,
						file,
						mime: file.type || "application/octet-stream",
						bytes: file.size,
					},
				],
			})),
		);
	};
	const loadFolderFiles = async (
		name: string,
		files: Array<{ file: File; relativePath: string }>,
	): Promise<void> =>
		uploadRoots([
			{
				kind: "folder",
				name,
				entries: files.map(({ file, relativePath }) => ({
					entryKind: "file" as const,
					relativePath,
					file,
					mime: file.type || "application/octet-stream",
					bytes: file.size,
				})),
			},
		]);
	const addCompletedAttachments = async (
		attachments: Array<{
			id: string;
			name: string;
			kind: "file" | "folder" | "generated";
			bytes: number;
			fileCount: number;
		}>,
		conversationId = store.activeConversationId,
	): Promise<void> => {
		if (!conversationId) return;
		await Promise.all(
			attachments.map((attachment) => store.attachments.list(conversationId, attachment.id)),
		);
		setState("attachments", (drafts) => [
			...drafts,
			...attachments.map((attachment) => ({
				kind: "attachment" as const,
				draftId: crypto.randomUUID(),
				conversationId,
				id: attachment.id,
				name: "",
				attachmentKind: "file" as const,
				bytes: 0,
				fileCount: 0,
				uploadState: "complete" as const,
				progress: 1,
			})),
		]);
	};
	const cancelAttachment = async (draftId: string): Promise<void> => {
		const conversationId = store.activeConversationId;
		const draft = attachments().find((candidate) => candidate.draftId === draftId);
		if (!conversationId || draft?.uploadState !== "uploading") return;
		setState("attachments", (drafts) =>
			drafts.map((candidate) =>
				candidate.draftId === draftId ? { ...candidate, uploadState: "cancelled" } : candidate,
			),
		);
		if (draft.uploadId)
			await store.attachments
				.cancelUpload({ conversationId, uploadId: draft.uploadId })
				.catch(() => undefined);
	};
	const retryAttachment = (draftId: string): void => {
		const conversationId = store.activeConversationId;
		const draft = attachments().find((candidate) => candidate.draftId === draftId);
		if (
			!conversationId ||
			!draft?.source ||
			(draft.uploadState !== "error" && draft.uploadState !== "cancelled")
		)
			return;
		void uploadRoot(draftId, draft.source, conversationId).catch((cause) =>
			setState("attachments", (item) => item.draftId === draftId, {
				uploadState: "error",
				error: cause instanceof Error ? cause.message : String(cause),
			}),
		);
	};
	const removeAttachment = async (draftId: string): Promise<void> => {
		const conversationId = store.activeConversationId;
		const draft = attachments().find((candidate) => candidate.draftId === draftId);
		if (!draft) return;
		if (draft.uploadState === "uploading") {
			await cancelAttachment(draftId);
		} else if (conversationId && draft.uploadState === "complete" && draft.id) {
			try {
				await store.attachments.discard(conversationId, draft.id);
			} catch (cause) {
				setState("attachmentError", cause instanceof Error ? cause.message : String(cause));
				return;
			}
		}
		setState("attachments", (drafts) =>
			drafts.filter((candidate) => candidate.draftId !== draftId),
		);
	};
	const dispatchMessage = async (): Promise<void> => {
		if (state.modelBusy) return;
		const value = state.composerText;
		if (!value.trim() && attachments().length === 0) return;
		const draftAttachments = state.attachments.filter(
			(draft) => draft.conversationId === store.activeConversationId,
		);
		if (attachments().some((file) => file.uploadState !== "complete")) return;
		const attachmentIds = draftAttachments.flatMap((file) => (file.id ? [file.id] : []));
		const message = value.trim();
		const before = store.errorMetadata;
		setState("sendError", null);
		setState("modelError", null);
		setState("modelBusy", true);
		try {
			await store.sendMessage(message, attachmentIds);
			const retained = store.errorMetadata;
			if (retained !== null && retained !== before) {
				setState("composerText", value);
				setState("attachments", draftAttachments);
				setState("sendError", retained.message);
				return;
			}
			// The Pi preflight accepted the message: the draft is consumed by
			// the Pi session and the thread updates via `pi.session.changed`.
			// Accepted drafts are never replayed as messages.
			setState("composerText", "");
			setState("attachments", []);
		} catch (cause) {
			setState("composerText", value);
			setState("attachments", draftAttachments);
			setState("sendError", cause instanceof Error ? cause.message : String(cause));
		} finally {
			setState("modelBusy", false);
		}
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
		attachments,
		setAttachmentError: (value: string | null) => setState("attachmentError", value),
		modelError: () => state.modelError,
		modelBusy: () => state.modelBusy,
		attachmentError: () => state.attachmentError,
		sendError: () => state.sendError,
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
		streaming,
		visibleConversations,
		loadFiles,
		loadFolderFiles,
		uploadRoots,
		addCompletedAttachments,
		cancelAttachment,
		retryAttachment,
		removeAttachment,
		dispatchMessage,
		selectModel,
		runSidebarAction,
		beginRename,
		saveRename,
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
