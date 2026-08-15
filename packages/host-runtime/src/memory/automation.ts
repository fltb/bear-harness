import type { DatabaseSync } from "node:sqlite";
import type { EventBus, HostEvent } from "../storage/event-bus.js";
import type { MemoryKind, MemoryService } from "./service.js";

const SENSITIVE = /密码|密钥|身份证|银行卡|住址|电话|病历|诊断|收入|工资|债务|性取向|政治|宗教/;

export class MemoryAutomation {
	private readonly unsubscribe: () => void;

	constructor(
		private readonly db: DatabaseSync,
		private readonly eventBus: EventBus,
		private readonly memory: MemoryService,
	) {
		this.unsubscribe = eventBus.subscribe((event) => this.handle(event));
	}

	dispose(): void {
		this.unsubscribe();
	}

	private handle(event: HostEvent): void {
		if (event.kind !== "message.user_sent" || !event.payload || typeof event.payload !== "object")
			return;
		const payload = event.payload as Record<string, unknown>;
		if (
			typeof payload.conversationId !== "string" ||
			typeof payload.messageId !== "string" ||
			typeof payload.versionId !== "string" ||
			typeof payload.text !== "string"
		)
			return;
		const detected = detectMemory(payload.text);
		if (!detected) return;
		const context = this.db
			.prepare(
				`SELECT c.companion_id, m.branch_id FROM conversations c
				 JOIN messages m ON m.conversation_id = c.id
				 JOIN onboarding_state o ON o.companion_id = c.companion_id
				 WHERE c.id = ? AND m.id = ?
				   AND COALESCE(json_extract(o.state_json, '$.decisions.relationship_memory_enabled'), 0) = 1`,
			)
			.get(payload.conversationId, payload.messageId) as
			| { companion_id: string; branch_id: string }
			| undefined;
		if (!context) return;
		const candidateId = this.memory.proposeCandidate({
			companionId: context.companion_id,
			kind: detected.kind,
			text: detected.text,
			why: detected.why,
			suggestedScope: "relationship",
			sourceKind: "extractor",
			sourceConversationId: payload.conversationId,
			sourceBranchId: context.branch_id,
			sourceMessageVersionId: payload.versionId,
		});
		if (!detected.needsConfirmation) {
			this.memory.decideCandidate({ candidateId, decision: "approve" });
			this.eventBus.publish("memory.auto_saved", {
				candidateId,
				conversationId: payload.conversationId,
			});
		}
	}
}

function detectMemory(text: string):
	| {
			kind: MemoryKind;
			text: string;
			why: string;
			needsConfirmation: boolean;
	  }
	| undefined {
	const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
	const nickname = normalized.match(/^(?:以后)?(?:请)?叫我[“\"]?([^”\"]{1,32})[”\"]?[。！!]?$/);
	if (nickname?.[1]) {
		return {
			kind: "preference",
			text: `用户希望被称为${nickname[1]}`,
			why: "明确称呼",
			needsConfirmation: false,
		};
	}
	const preference = normalized.match(/^我(不?喜欢|讨厌|偏好)(.{1,256})$/);
	if (preference) {
		return {
			kind: "preference",
			text: normalized,
			why: "明确偏好",
			needsConfirmation: SENSITIVE.test(normalized),
		};
	}
	const remember = normalized.match(/^(?:请)?记住[：:,，\s]*(.{1,512})$/);
	if (remember?.[1]) {
		return {
			kind: /我们|一起|共同/.test(remember[1]) ? "event" : "fact",
			text: remember[1],
			why: "用户明确要求记住",
			needsConfirmation: SENSITIVE.test(remember[1]),
		};
	}
	return undefined;
}
