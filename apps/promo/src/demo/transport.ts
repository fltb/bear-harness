import type { HostTransport } from "@bear-harness/companion-client";
import type {
	AnyRpcEndpoint,
	ConversationDetail,
	ConversationSummary,
	LivePush,
	RequestOf,
} from "@bear-harness/protocol";
import { InvalidationBatch, LivePushBatch, Run } from "@bear-harness/protocol/schema";
import { DEMO_CHARACTERS, NIGHT_READING_MARKDOWN, type PromoScene, SCENARIO } from "./scenario";

export const DEMO_MODEL = Object.freeze({
	providerId: "demo",
	modelId: "scripted",
	label: "预设情景模型",
	providerName: "白熊客栈制作环境",
	supportsImages: true,
	thinkingLevels: ["minimal", "low", "medium", "high"] as const,
	createdAt: "2026-09-13T00:00:00.000Z",
	enabled: true,
	readiness: "ready" as const,
});
const NOW = "2026-09-13T00:00:00.000Z";
const ARTIFACT_ID = "artifact-night-reading";
const RUN_ID = "run-night-reading";
const ARTIFACT_SHA = "28c44576ac11a5fb6646ba8b0ebb7f9abc96e8adeef92230b25d13a07e13dd71";
const EMPTY_LIVE = () => ({
	isStreaming: false,
	isRetrying: false,
	retryAttempt: 0,
	isCompacting: false,
	pendingToolCallIds: [],
	steering: [],
	followUp: [],
});

type DemoMessage = Record<string, unknown>;
type DemoEntry = {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: DemoMessage;
};
type DemoConversation = {
	detail: ConversationDetail;
	characterId: string;
	entries: DemoEntry[];
	nextMessage: number;
};

export interface DemoInspect {
	conversationIds: Record<string, string[]>;
	memorySaved: boolean;
	runStatus: "idle" | "running" | "completed";
	pendingScene: number | null;
	fault: string | null;
}

export class DemoTransportError extends Error {
	readonly endpoint: string;
	constructor(endpoint: string, message: string) {
		super(`${endpoint}: ${message}`);
		this.name = "DemoTransportError";
		this.endpoint = endpoint;
	}
}

const textMessage = (role: "user" | "assistant", text: string, timestamp: number): DemoMessage =>
	role === "user"
		? { role, content: text, timestamp }
		: {
				role,
				content: [{ type: "text", text }],
				provider: DEMO_MODEL.providerId,
				model: DEMO_MODEL.modelId,
				api: "openai-completions",
				timestamp,
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};

export class DemoTransport implements HostTransport {
	private readonly memoryConsent = new Map<string, boolean>();
	private memorySaved = false;
	private runStatus: "idle" | "running" | "completed" = "idle";
	private workConversationId: string | null = null;
	private fault: string | null = null;
	private sequence = 0;
	private conversationCounter = 0;
	private readonly conversations = new Map<string, DemoConversation>();
	private readonly invalidations = new Set<(batch: unknown) => void>();
	private readonly streams = new Set<{ queue: unknown[]; wake: (() => void) | null }>();
	private pending: {
		scene: PromoScene;
		conversationId: string;
		response: string;
		timestamp: number;
	} | null = null;
	private preparedScene = 1;
	private readonly settled = new Set<number>();

	constructor() {
		this.createConversation("jizhou-night-reading", "jizhou", "夜班闲聊");
		this.createConversation("rj-moving-books", "rj", "新手套");
		this.createConversation("volibear-wind", "volibear", "冰封河岸");
	}

	private createConversation(id: string, characterId: string, title: string): DemoConversation {
		const entries: DemoEntry[] = [];
		const character = DEMO_CHARACTERS[characterId];
		if (!character) throw new Error(`Missing demo character ${characterId}`);
		const detail = {
			conversationId: id,
			name: title,
			branch: { entries: entries as never[], latestLeafIds: [], hasMoreBefore: false },
			live: EMPTY_LIVE(),
		} as ConversationDetail;
		const value = { detail, characterId, entries, nextMessage: 1 };
		this.conversations.set(id, value);
		return value;
	}

	private ok<T>(data: T) {
		return { ok: true as const, data };
	}
	private fail(endpoint: string, message: string): never {
		this.fault = `${endpoint}: ${message}`;
		this.emitFault();
		throw new DemoTransportError(endpoint, message);
	}
	private emitFault() {
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent("demo:fault", { detail: { message: this.fault } }));
			const target = document.getElementById("demo-error");
			if (target) {
				target.textContent = this.fault ?? "演示传输失败";
				target.hidden = false;
			}
		}
	}
	private refreshDetail(value: DemoConversation) {
		value.detail = {
			...value.detail,
			branch: {
				...value.detail.branch,
				entries: value.entries as never[],
				activeLeafId: value.entries.at(-1)?.id,
				latestLeafIds: value.entries.length ? [value.entries.at(-1)?.id as string] : [],
			},
		};
	}
	private emit(event: LivePush) {
		const batch = LivePushBatch.parse({ events: [event] });
		for (const stream of this.streams) {
			stream.queue.push(batch);
			stream.wake?.();
		}
	}
	private invalidate(characterId: string, keys: unknown[]) {
		const batch = InvalidationBatch.parse({ notices: [{ scope: "character", characterId, keys }] });
		for (const receive of this.invalidations) receive(batch);
	}
	private pi(conversationId: string, event: unknown) {
		const value = this.conversations.get(conversationId);
		if (!value) this.fail("demo.event", "unknown conversation");
		this.sequence += 1;
		this.emit({
			type: "pi",
			characterId: value.characterId,
			conversationId,
			event: event as never,
			version: { instanceId: "demo-instance", sequence: this.sequence },
		});
		value.detail.live.version = { instanceId: "demo-instance", sequence: this.sequence };
	}
	private runEvent() {
		const run = this.runProjection();
		this.emit({ type: "run", characterId: "jizhou", run });
	}
	private runProjection() {
		return Run.parse({
			id: RUN_ID,
			conversationId: this.workConversationId ?? "jizhou-night-reading",
			triggerEntryId: "demo-user-9",
			executorProfile: "demo",
			title: "整理读书邀请",
			status: this.runStatus,
			artifacts:
				this.runStatus === "completed"
					? [
							{
								id: ARTIFACT_ID,
								name: "night-reading.md",
								mime: "text/markdown",
								bytes: new TextEncoder().encode(NIGHT_READING_MARKDOWN).byteLength,
								sha256: ARTIFACT_SHA,
								verification: "verified",
								saved: false,
								adopted: false,
								createdAt: NOW,
							},
						]
					: [],
			summary: this.runStatus === "completed" ? "活动说明已整理完成。" : undefined,
			evidence: [],
			startedAt: NOW,
			completedAt: this.runStatus === "completed" ? NOW : undefined,
			resultReportedAt: this.runStatus === "completed" ? NOW : undefined,
			controller: "attached",
			actions: this.runStatus === "running" ? ["steer", "interrupt", "cancel"] : [],
		});
	}
	prepare(sceneId: number): void {
		this.preparedScene = sceneId;
	}

	private addEntry(
		value: DemoConversation,
		role: "user" | "assistant",
		text: string,
		id: string,
		timestamp: number,
	) {
		const entry: DemoEntry = {
			type: "message",
			id,
			parentId: value.entries.at(-1)?.id ?? null,
			timestamp: NOW,
			message: textMessage(role, text, timestamp),
		};
		value.entries.push(entry);
		this.refreshDetail(value);
	}

	private sceneForText(text: string): PromoScene | undefined {
		return SCENARIO.find((scene) => scene.user === text);
	}

	private updateStreaming(scene: PromoScene, progress: number) {
		const current = this.pending;
		if (!current || current.scene.id !== scene.id)
			this.fail("message.send", `scene ${scene.id} has no pending response`);
		const bounded = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
		const count = Math.floor(scene.assistant.length * bounded);
		this.pi(current.conversationId, {
			type: "message_update",
			message: textMessage("assistant", scene.assistant.slice(0, count), current.timestamp),
		});
	}

	async invoke<E extends AnyRpcEndpoint>(endpoint: E, request: RequestOf<E>): Promise<unknown> {
		try {
			const result = (await this.dispatch(
				endpoint,
				endpoint.request.parse(request) as RequestOf<E>,
			)) as { ok: true; data: unknown };
			return { ok: true, data: endpoint.response.parse(result.data) };
		} catch (error) {
			return this.fail(endpoint.channel, error instanceof Error ? error.message : String(error));
		}
	}

	private async dispatch<E extends AnyRpcEndpoint>(
		endpoint: E,
		request: RequestOf<E>,
	): Promise<unknown> {
		const channel = endpoint.channel;
		const owner = request as { characterId: string; conversationId?: string; runId?: string };
		try {
			if (endpoint.scope === "character") {
				if (!DEMO_CHARACTERS[owner.characterId]) return this.fail(channel, "unknown character");
				if (
					owner.conversationId &&
					this.conversations.get(owner.conversationId)?.characterId !== owner.characterId
				)
					return this.fail(channel, "conversation ownership mismatch");
				if (
					owner.runId &&
					(owner.characterId !== "jizhou" || owner.runId !== RUN_ID || this.runStatus === "idle")
				)
					return this.fail(channel, "run ownership mismatch");
			}
			switch (channel) {
				case "diagnostics.renderer": {
					const payload = request as { records: { event: string; error?: { message: string } }[] };
					const fault = payload.records.find((record) => record.event === "fault");
					if (fault) return this.fail(channel, fault.error?.message ?? "renderer fault");
					return this.ok({});
				}
				case "canon.listModules":
					return this.ok({ modules: [] });
				case "canon.listSources":
					return this.ok({ sources: [] });
				case "memory.localEmbeddingAcquisitionStatus":
					return this.ok({ revision: 0, phase: "idle", downloadedBytes: 0 });
				case "memory.localEmbeddingInventory":
					return this.ok({
						candidates: [
							{
								id: "private-uninstalled",
								name: "本演示的自动记忆已关闭",
								dimensions: 384,
								isDefault: true,
								target: { kind: "candidate", candidateId: "private-uninstalled" },
								installed: false,
							},
						],
					});
				case "model.systemDefaults.get":
					return this.ok({
						reply: { providerId: DEMO_MODEL.providerId, modelId: DEMO_MODEL.modelId },
						vision: { mode: "auto" },
						thinkingLevel: "low",
					});
				case "bootstrap.get":
					return this.ok({ defaultCharacterId: "jizhou" });
				case "character.memoryGet":
					return this.ok({ enabled: this.memoryConsent.get(owner.characterId) ?? false });
				case "character.memorySet": {
					const enabled = (request as { enabled: boolean }).enabled;
					this.memoryConsent.set(owner.characterId, enabled);
					return this.ok({ enabled });
				}
				case "snapshot.get":
					return this.ok({
						onboarding: { status: "complete", stateData: { answers: {} } },
						character: DEMO_CHARACTERS[owner.characterId],
					});
				case "character.get":
					return this.ok({ character: DEMO_CHARACTERS[owner.characterId] });
				case "character.list":
					return this.ok({
						characters: Object.values(DEMO_CHARACTERS).map((character) => ({
							id: character.id,
							name: character.name,
							subtitle: character.character.subtitle,
							avatarUrl: character.visual.avatarUrl,
						})),
					});
				case "character.packageGet": {
					const id = (request as { characterId: string }).characterId;
					const character = DEMO_CHARACTERS[id];
					if (!character) return this.fail(channel, `unknown character ${id}`);
					return this.ok({
						package: {
							characterId: id,
							origin: id === "jizhou" ? "official" : "imported",
							writable: false,
							yaml: `id: ${id}\nname: ${character.name}\n`,
							sha256: ARTIFACT_SHA,
							character,
							manifest: {},
							manifestSchema: {},
						},
					});
				}
				case "character.deletionStatusGet": {
					const id = (request as { characterId: string }).characterId;
					return this.ok({
						status: {
							characterId: id,
							default: id === "jizhou",
							runtimePresent: true,
							packagePresent: true,
						},
					});
				}
				case "character.pluginTrustGet": {
					const payload = request as { characterId: string };
					return this.ok({
						trust: {
							characterId: payload.characterId,
							origin: payload.characterId === "jizhou" ? "official" : "imported",
							pluginHash: "",
							pluginsPresent: false,
							trusted: true,
						},
					});
				}
				case "onboarding.get":
					return this.ok({ status: "complete", stateData: { answers: {} } });
				case "conversation.list": {
					const characterId = owner.characterId;
					const conversations = [...this.conversations.values()]
						.filter((item) => item.characterId === characterId)
						.map((item) => this.summary(item));
					return this.ok({ conversations });
				}
				case "conversation.open": {
					const id = (request as { conversationId: string }).conversationId;
					const value = this.conversations.get(id);
					if (!value) return this.fail(channel, `unknown conversation ${id}`);
					return this.ok(value.detail);
				}
				case "conversation.create": {
					const title =
						this.preparedScene === 10
							? "读书邀请"
							: ((request as { title?: string }).title ?? "新对话");
					const id =
						this.preparedScene === 10
							? "jizhou-night-reading-2"
							: `${owner.characterId}-conversation-${++this.conversationCounter}`;
					const value = this.createConversation(id, owner.characterId, title);
					this.invalidate(owner.characterId, [["conversations"]]);
					return this.ok(value.detail);
				}
				case "conversation.history": {
					const id = (request as { conversationId: string }).conversationId;
					const value = this.conversations.get(id);
					if (!value) return this.fail(channel, `unknown conversation ${id}`);
					return this.ok({ entries: value.entries as never[] });
				}
				case "message.send": {
					const payload = request as { conversationId: string; text: string };
					const scene = this.sceneForText(payload.text);
					const value = this.conversations.get(payload.conversationId);
					if (!scene || !value || value.characterId !== owner.characterId)
						return this.fail(channel, "message is not in the approved scripted scenario");
					if (this.pending || this.settled.has(scene.id))
						return this.fail(channel, "duplicate or overlapping scripted send");
					this.addEntry(value, "user", payload.text, `demo-user-${scene.id}`, scene.id * 1000);
					this.pending = {
						scene,
						conversationId: payload.conversationId,
						response: scene.assistant,
						timestamp: value.nextMessage++,
					};
					value.detail = { ...value.detail, live: { ...value.detail.live, isStreaming: true } };
					const userEntry = value.entries.at(-1);
					if (!userEntry) return this.fail(channel, "scripted user entry was not appended");
					this.pi(payload.conversationId, { type: "agent_start" });
					this.pi(payload.conversationId, {
						type: "message_end",
						message: userEntry.message,
					});
					if (scene.id === 9) {
						this.tool(value, "explicit_memory", "demo-memory-call", {
							changed: true,
							content: "- 喜欢靠窗坐。\n- 和朋友一起看书时，喜欢各自阅读，读到有意思的地方再聊。\n",
						});
						this.memorySaved = true;
					}
					if (scene.id === 11) {
						this.workConversationId = payload.conversationId;
						this.runStatus = "running";
						this.runEvent();
					}
					return this.ok({});
				}
				case "memory.inspect": {
					const payload = request as { characterId: string; kind: string };
					if (!DEMO_CHARACTERS[payload.characterId]) return this.fail(channel, "unknown character");
					const explicit =
						payload.kind === "explicit"
							? payload.characterId === "jizhou" && this.memorySaved
								? "- 喜欢靠窗坐。\n- 和朋友一起看书时，喜欢各自阅读，读到有意思的地方再聊。\n"
								: ""
							: undefined;
					return this.ok({
						characterId: payload.characterId,
						relationshipMemoryEnabled: false,
						explicit,
						items: [],
					});
				}
				case "companionState.get": {
					const conversation = this.conversations.get(
						(request as { conversationId: string }).conversationId,
					);
					const character = conversation && DEMO_CHARACTERS[conversation.characterId];
					if (!character) return this.fail(channel, "unknown conversation owner");
					const happy =
						conversation?.detail.conversationId === "jizhou-night-reading" && this.settled.has(2);
					return this.ok({
						schema: { type: "object", properties: {} },
						state: {
							character: { document: {}, revisions: { conversation: 0, global: 0 } },
							display: {
								sceneId: character.visual.defaultSceneId,
								expressionId: happy ? "happy" : character.visual.defaultExpressionId,
							},
							revisions: { display: happy ? 1 : 0 },
						},
					});
				}
				case "run.list": {
					const { conversationId, scope } = request as { conversationId?: string; scope?: string };
					const visible =
						owner.characterId === "jizhou" &&
						this.runStatus !== "idle" &&
						(!conversationId || conversationId === this.workConversationId) &&
						(scope !== "unfinished" || this.runStatus === "running");
					return this.ok({ runs: visible ? [this.runProjection()] : [] });
				}
				case "run.get":
					return this.ok({
						run: this.runProjection(),
						instruction: "整理读书邀请 Markdown 文件",
						inputPaths: [],
						evidence: [],
					});
				case "artifact.read": {
					const payload = request as {
						conversationId: string;
						runId: string;
						artifactId: string;
						offset?: number;
						length?: number;
					};
					if (
						payload.conversationId !== this.workConversationId ||
						payload.runId !== RUN_ID ||
						payload.artifactId !== ARTIFACT_ID ||
						this.runStatus !== "completed"
					)
						return this.fail(channel, "artifact ownership mismatch or unavailable");
					const bytes = new TextEncoder().encode(NIGHT_READING_MARKDOWN);
					const offset = payload.offset ?? 0;
					const end = Math.min(bytes.length, offset + (payload.length ?? bytes.length));
					let binary = "";
					for (const byte of bytes.slice(offset, end)) binary += String.fromCharCode(byte);
					return this.ok({
						artifact: this.runProjection().artifacts[0],
						offset,
						nextOffset: end,
						eof: end >= bytes.length,
						base64: btoa(binary),
					});
				}
				case "artifact.saveAs": {
					const payload = request as { conversationId: string; runId: string; artifactId: string };
					if (
						payload.conversationId !== this.workConversationId ||
						payload.runId !== RUN_ID ||
						payload.artifactId !== ARTIFACT_ID ||
						this.runStatus !== "completed"
					)
						return this.fail(channel, "artifact ownership mismatch or unavailable");
					window.dispatchEvent(
						new CustomEvent("demo:download", {
							detail: { filename: "night-reading.md", content: NIGHT_READING_MARKDOWN },
						}),
					);
					return this.ok({ outcome: "completed" });
				}
				case "settings.get": {
					return this.ok({
						settings: {
							firstRunStage: "role",
							relationshipMemoryEnabled: false,
							networkProxy: { mode: "direct" },
							memoryVectorService: { enabled: false, provider: "none" },
							modelDownloadSource: { type: "official" },
						},
					});
				}
				case "settings.capabilitiesGet":
					return this.ok({
						networkProxyModes: [{ id: "direct" }, { id: "auto" }, { id: "manual" }],
						memoryVectorProviders: [{ id: "none", onboarding: true }],
						memoryVectorPresets: [],
						localEmbeddingCandidates: [
							{
								id: "private-uninstalled",
								name: "本演示的自动记忆已关闭",
								dimensions: 384,
								isDefault: true,
							},
						],
					});
				case "model.pool.get":
					return this.ok({ models: [DEMO_MODEL] });
				case "model.defaults.get":
					return this.ok({
						reply: { providerId: DEMO_MODEL.providerId, modelId: DEMO_MODEL.modelId },
						vision: { mode: "auto" },
						thinkingLevel: "low",
						onboardingComplete: true,
					});
				case "model.route.get":
					return this.ok({
						conversationId: (request as { conversationId: string }).conversationId,
						selected: { providerId: DEMO_MODEL.providerId, modelId: DEMO_MODEL.modelId },
						thinking: {
							level: "low",
							defaultLevel: "low",
							levels: ["minimal", "low", "medium", "high"],
						},
					});
				case "provider.list":
					return this.ok({ providers: [] });
				default:
					return this.fail(channel, "unsupported in isolated private promo transport");
			}
		} catch (error) {
			if (error instanceof DemoTransportError) throw error;
			return this.fail(channel, error instanceof Error ? error.message : String(error));
		}
	}

	private summary(value: DemoConversation): ConversationSummary {
		const first = value.entries.find((entry) => entry.message.role === "user");
		return {
			conversationId: value.detail.conversationId,
			name: value.detail.name,
			created: NOW,
			modified: NOW,
			messageCount: value.entries.length,
			firstMessage: typeof first?.message.content === "string" ? first.message.content : "",
			isStreaming: value.detail.live.isStreaming,
		};
	}

	listenInvalidations(
		receive: (batch: unknown) => void,
		_fail: (error: unknown) => void,
	): () => void {
		this.invalidations.add(receive);
		return () => {
			this.invalidations.delete(receive);
		};
	}

	subscribeLive(signal: AbortSignal): Promise<AsyncIterable<unknown>> {
		const stream = { queue: [] as unknown[], wake: null as (() => void) | null };
		this.streams.add(stream);
		const abort = () => stream.wake?.();
		signal.addEventListener("abort", abort, { once: true });
		const streams = this.streams;
		return Promise.resolve({
			async *[Symbol.asyncIterator]() {
				try {
					while (!signal.aborted) {
						if (!stream.queue.length)
							await new Promise<void>((resolve) => {
								stream.wake = resolve;
							});
						stream.wake = null;
						while (stream.queue.length && !signal.aborted) yield stream.queue.shift();
					}
				} finally {
					signal.removeEventListener("abort", abort);
					streams.delete(stream);
				}
			},
		});
	}

	private tool(value: DemoConversation, toolName: string, toolCallId: string, data: unknown) {
		const message = {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: JSON.stringify(data) }],
			details: { ok: true, data },
			isError: false,
			timestamp: this.preparedScene * 1000 + 1,
		};
		const entry: DemoEntry = {
			type: "message",
			id: toolCallId,
			parentId: value.entries.at(-1)?.id ?? null,
			timestamp: NOW,
			message,
		};
		value.entries.push(entry);
		this.refreshDetail(value);
		this.pi(value.detail.conversationId, { type: "message_end", message });
	}

	advance(sceneId: number, phase: string, progress = 1): void {
		if (phase === "response") {
			const scene = SCENARIO.find((item) => item.id === sceneId);
			if (scene?.user && !this.settled.has(sceneId)) this.updateStreaming(scene, progress);
			return;
		}
		if (phase === "settled") {
			const scene = SCENARIO.find((item) => item.id === sceneId);
			if (!scene?.user || this.settled.has(sceneId)) return;
			const current = this.pending;
			if (!current || current.scene.id !== sceneId)
				this.fail("demo.advance", `scene ${sceneId} is not pending`);
			const value = this.conversations.get(current.conversationId);
			if (!value) this.fail("demo.advance", "scripted conversation disappeared");
			if (sceneId === 11)
				this.tool(value, "host_delegate", "demo-work-call", {
					accepted: true,
					executor: "pi",
					runId: RUN_ID,
				});
			this.addEntry(
				value,
				"assistant",
				current.response,
				`demo-assistant-${sceneId}`,
				current.timestamp,
			);
			this.pi(current.conversationId, {
				type: "message_end",
				message: textMessage("assistant", current.response, current.timestamp),
			});
			value.detail = {
				...value.detail,
				live: {
					...EMPTY_LIVE(),
					version: { instanceId: "demo-instance", sequence: this.sequence + 1 },
				},
			};
			this.pi(current.conversationId, { type: "agent_settled", reason: "completed" });
			this.invalidate(value.characterId, [
				["conversation", current.conversationId],
				["conversations"],
			]);
			this.pending = null;
			this.settled.add(sceneId);
			if (sceneId === 2)
				this.invalidate(value.characterId, [["companionState", current.conversationId]]);
			return;
		}
		if (phase === "action" && sceneId === 12 && this.runStatus === "running") {
			this.runStatus = "completed";
			this.runEvent();
			this.invalidate("jizhou", [["runs"]]);
		}
	}

	inspect(): DemoInspect {
		const conversationIds: Record<string, string[]> = {};
		for (const value of this.conversations.values()) {
			const ids = conversationIds[value.characterId] ?? [];
			ids.push(value.detail.conversationId);
			conversationIds[value.characterId] = ids;
		}
		return {
			conversationIds,
			memorySaved: this.memorySaved,
			runStatus: this.runStatus,
			pendingScene: this.pending?.scene.id ?? null,
			fault: this.fault,
		};
	}
	dispose(): void {
		this.invalidations.clear();
		for (const stream of this.streams) stream.wake?.();
		this.streams.clear();
		this.pending = null;
	}
}

export function createDemoTransport(): DemoTransport {
	return new DemoTransport();
}
