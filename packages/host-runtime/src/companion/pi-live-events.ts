import type {
	ConversationDetail,
	PiLiveState,
	PiSessionLiveEvent,
	PiTimelineEntry,
} from "@bear-harness/protocol";
import {
	ConversationDetail as ConversationDetailSchema,
	PiMessageChoices as PiMessageChoicesSchema,
	PiSessionLiveEvent as PiSessionLiveEventSchema,
} from "@bear-harness/protocol/schema";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiSessionEvent, PiSnapshot } from "./pi-runtime.js";

type Session = NonNullable<PiSnapshot>;
type Assistant = Extract<AgentMessage, { role: "assistant" }>;
type Version = { current: number; leafIds: string[] };
const TEXT_LIMIT = 65_536;

/** Security-safe, bounded wire projection of one native Pi session. */
export function projectPiConversationDetail(session: Session): ConversationDetail {
	const activeLeafId = session.sessionManager.getLeafId();
	const versions = messageVersions(session.sessionManager);
	return ConversationDetailSchema.parse({
		sessionId: session.sessionId,
		name: (session.sessionName ?? "").slice(0, 4096),
		timeline: {
			entries: session.sessionManager
				.buildContextEntries()
				.slice(-100)
				.flatMap((entry) => {
					const projected = projectEntry(entry, versions.get(entry.id));
					return projected ? [projected] : [];
				}),
			...(activeLeafId ? { activeLeafId } : {}),
		},
		live: projectPiLiveState(session),
	});
}

export function projectPiLiveState(session: Session): PiLiveState {
	const message = session.state.streamingMessage;
	return {
		isStreaming: session.isStreaming,
		...(message?.role === "assistant" ? { streamingMessage: assistant(message, true) } : {}),
		queuedUserMessages: [...session.getSteeringMessages(), ...session.getFollowUpMessages()]
			.slice(0, 20)
			.map((text) => text.slice(0, TEXT_LIMIT)),
		...(session.state.errorMessage
			? { errorMessage: session.state.errorMessage.slice(0, 4096) }
			: {}),
	} as PiLiveState;
}

export function projectPiSessionLiveEvent(
	envelope: PiSessionEvent,
	session: Session | undefined,
): PiSessionLiveEvent | undefined {
	if (session?.sessionId !== envelope.sessionId) return;
	const event = envelope.event;
	const tool =
		event.type.startsWith("tool_execution_") && "toolCallId" in event && "toolName" in event
			? {
					toolCallId: event.toolCallId.slice(0, 256),
					toolName: event.toolName.slice(0, 200),
					status:
						event.type !== "tool_execution_end"
							? ("running" as const)
							: event.isError
								? ("failed" as const)
								: ("succeeded" as const),
				}
			: undefined;
	return PiSessionLiveEventSchema.parse({
		sessionId: envelope.sessionId,
		type: event.type,
		live: projectPiLiveState(session),
		...(tool ? { tool } : {}),
	});
}

function projectEntry(entry: SessionEntry, version?: Version): PiTimelineEntry | undefined {
	const base = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
	if (entry.type !== "message") return { ...base, kind: entry.type };
	const message = entry.message;
	if (message.role === "user")
		return { ...base, kind: "message", role: "user", text: text(message.content) };
	if (message.role === "assistant")
		return {
			...base,
			kind: "message",
			role: "assistant",
			...assistant(message, false),
			...(version ? { version } : {}),
		} as PiTimelineEntry;
	if (message.role !== "toolResult" || !message.toolName || !message.toolCallId) return;
	const data = toolData(message.details);
	const mediaId =
		message.toolName === "host_media" && typeof data?.mediaId === "string"
			? data.mediaId
			: undefined;
	const choices =
		message.toolName === "host_choices" ? PiMessageChoicesSchema.safeParse(data) : undefined;
	return {
		...base,
		kind: "message",
		role: "tool",
		toolName: message.toolName.slice(0, 200),
		toolCallId: message.toolCallId.slice(0, 256),
		status: message.isError ? "failed" : "succeeded",
		...(mediaId && /^[a-z][a-z0-9_]{0,63}$/u.test(mediaId) ? { mediaId } : {}),
		...(choices?.success ? { choices: choices.data } : {}),
	};
}

function toolData(details: unknown): Record<string, unknown> | undefined {
	if (!details || typeof details !== "object" || !("ok" in details) || details.ok !== true) return;
	if (!("data" in details) || !details.data || typeof details.data !== "object") return;
	return details.data as Record<string, unknown>;
}

function assistant(message: Assistant, streaming: boolean) {
	const content = parts(message.content);
	const value = text(message.content);
	const toolCalls = content
		.filter((part) => part.type === "toolCall" && part.name && part.id)
		.slice(0, 100)
		.map((part) => ({
			toolName: String(part.name).slice(0, 200),
			toolCallId: String(part.id).slice(0, 256),
		}));
	return {
		...(value ? { text: value } : {}),
		...(toolCalls.length ? { toolCalls } : {}),
		stopReason: streaming || message.stopReason === "pending" ? "pending" : message.stopReason,
		...(message.errorMessage ? { errorMessage: message.errorMessage.slice(0, 4096) } : {}),
	};
}

function messageVersions(manager: SessionManager): Map<string, Version> {
	const result = new Map<string, Version>();
	let user: SessionEntry | undefined;
	for (const entry of manager.getBranch()) {
		if (isRole(entry, "user")) user = entry;
		if (!user || !isRole(entry, "assistant")) continue;
		const siblings = (
			user.parentId
				? manager.getChildren(user.parentId)
				: manager.getTree().map(({ entry: root }) => root)
		)
			.filter((candidate) => isRole(candidate, "user"))
			.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
		if (siblings.length > 1 && siblings.length <= 100)
			result.set(entry.id, {
				current: siblings.findIndex(({ id }) => id === user?.id),
				leafIds: siblings.map(({ id }) =>
					id === user?.id ? (manager.getLeafId() ?? id) : latestLeaf(manager, id),
				),
			});
		user = undefined;
	}
	return result;
}

function latestLeaf(manager: SessionManager, entryId: string): string {
	const children = manager.getChildren(entryId);
	if (!children.length) return entryId;
	return latestLeaf(
		manager,
		children.reduce((left, right) => (right.timestamp > left.timestamp ? right : left)).id,
	);
}
function isRole<R extends "user" | "assistant">(
	entry: SessionEntry | undefined,
	role: R,
): entry is SessionEntry & { type: "message"; message: Extract<AgentMessage, { role: R }> } {
	return entry?.type === "message" && entry.message.role === role;
}
function parts(content: unknown): Array<Record<string, unknown>> {
	return Array.isArray(content)
		? content.filter(
				(part): part is Record<string, unknown> => typeof part === "object" && part !== null,
			)
		: [];
}
function text(content: unknown): string {
	if (typeof content === "string") return content.slice(0, TEXT_LIMIT);
	return parts(content)
		.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n")
		.slice(0, TEXT_LIMIT);
}
