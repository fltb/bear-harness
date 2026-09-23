/** Thin provider extensions; the ACP controller does not classify providers or infer turns. */
import type * as acp from "@agentclientprotocol/sdk";

export interface AcpExtensions {
	steeringMethod?: string;
	shutdownMethod?: string;
}
export interface AcpResultReader {
	update(
		update: acp.SessionUpdate,
	): { suppress?: boolean; evidence?: { kind: string; data: unknown } } | undefined;
	finish(response: acp.PromptResponse): string | undefined;
	reset(): void;
}
export interface AcpDialect {
	extensions(initialized: acp.InitializeResponse): AcpExtensions;
	result(): AcpResultReader;
}
export const standardAcpDialect: AcpDialect = {
	extensions: () => ({}),
	result: () => ({ update: () => undefined, finish: () => undefined, reset: () => undefined }),
};
export const piAcpDialect: AcpDialect = {
	extensions: (response) => ({
		...(response.agentCapabilities?._meta?.bearNativeShutdown === true
			? { shutdownMethod: "_bear/shutdown" }
			: {}),
		...(response._meta?.steering &&
		typeof response._meta.steering === "object" &&
		"supported" in response._meta.steering &&
		response._meta.steering.supported === true
			? { steeringMethod: "_session/steering" }
			: {}),
	}),
	result: () => ({
		update(update) {
			if (update.sessionUpdate !== "agent_message_chunk") return;
			const event = update._meta?.bearEvent;
			if (
				event &&
				typeof event === "object" &&
				"type" in event &&
				["turn_start", "auto_retry_start", "auto_retry_end"].includes(String(event.type))
			)
				return { suppress: true, evidence: { kind: `pi.${event.type}`, data: event } };
			if (typeof update._meta?.bearError === "string")
				return {
					suppress: true,
					evidence: { kind: "acp.error", data: { message: update._meta.bearError } },
				};
		},
		finish: (response) =>
			typeof response._meta?.bearFinalResponse === "string"
				? response._meta.bearFinalResponse.trim() || undefined
				: undefined,
		reset() {},
	}),
};
export const codexAcpDialect: AcpDialect = {
	extensions: (response) => ({
		...(response._meta?.steering &&
		typeof response._meta.steering === "object" &&
		"supported" in response._meta.steering &&
		response._meta.steering.supported === true
			? { steeringMethod: "_session/steering" }
			: {}),
	}),
	result: () => {
		let messageId: string | undefined;
		let text = "";
		let truncated = false;
		return {
			update(update) {
				if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text")
					return;
				const meta = update._meta?.codex;
				if (
					!meta ||
					typeof meta !== "object" ||
					!("phase" in meta) ||
					!("messageId" in update) ||
					meta.phase !== "final_answer" ||
					typeof update.messageId !== "string"
				)
					return;
				if (messageId !== update.messageId) {
					messageId = update.messageId;
					text = "";
					truncated = false;
				}
				text += update.content.text;
				if (text.length > 65536) {
					text = text.slice(-65536);
					truncated = true;
				}
			},
			finish: () => {
				if (!text.trim()) throw { kind: "unavailable", reason: "runner_final_result_missing" };
				return `${truncated ? "[Final answer excerpt]\n" : ""}${text.trim()}`;
			},
			reset() {
				messageId = undefined;
				text = "";
				truncated = false;
			},
		};
	},
};
