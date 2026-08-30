import { createServer } from "node:http";

const directMemoryTexts = [
	"E2E_DIRECT_MEMORY_A：我们约定暗号是北辰",
	"E2E_DIRECT_MEMORY_B：我们约定暗号是北辰",
] as const;
const port = Number(process.env.BEAR_E2E_PROVIDER_PORT ?? "3211");
// The Web E2E harness configures this test provider with the canonical model ID "rule-model".
// Keep the deterministic response script model-agnostic; model selection belongs to the tests.
let toolSequence = 0;
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
const prompts: string[] = [];

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(text).join("\n");
	if (value && typeof value === "object") {
		const record = value as { text?: unknown; content?: unknown };
		return text(record.text ?? record.content);
	}
	return "";
}

function image(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(image);
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.type === "image" ||
		record.type === "image_url" ||
		"image_url" in record ||
		Object.values(record).some(image)
	);
}

function reply(payload: {
	messages?: Array<{
		role?: string;
		content?: unknown;
		tool_calls?: Array<{ function?: { name?: string } }>;
	}>;
}) {
	const messages = payload.messages ?? [];
	const prompt = messages.map((message) => text(message.content)).join("\n");
	const hostContext =
		[...prompt.matchAll(/<host_context>\n([\s\S]*?)<\/host_context>/g)].at(-1)?.[1] ?? "";
	prompts.push(prompt);
	const latestUser = [...messages].reverse().find((message) => message.role === "user");
	const latestUserContent = text(latestUser?.content);
	const current =
		[
			...latestUserContent.matchAll(/<current_user_message>\n([\s\S]*?)<\/current_user_message>/g),
		].at(-1)?.[1] ?? latestUserContent;
	const afterUser = latestUser ? messages.slice(messages.lastIndexOf(latestUser) + 1) : [];
	const currentCalls = afterUser.flatMap((message) =>
		(message.tool_calls ?? []).flatMap((call) => (call.function?.name ? [call.function.name] : [])),
	);
	const toolResult = afterUser.some((message) => message.role === "tool");
	const toolText = afterUser
		.filter((message) => message.role === "tool")
		.map((message) => text(message.content))
		.join("\n");
	const invoke = (tool: string, args: Record<string, unknown>) => {
		calls.push({ tool, args });
		return { tool, args };
	};
	if (prompt.includes("情境切分与记忆提取专家")) {
		const marker = directMemoryTexts.find((value) => prompt.includes(value));
		const extractedMessages = [...prompt.matchAll(/^\[([^\]]+)] \[(user|assistant)] \[[^\]]+]:/gm)];
		const messageIds = extractedMessages.map((match) => match[1]);
		const assistantId = extractedMessages.findLast((match) => match[2] === "assistant")?.[1];
		return {
			content: JSON.stringify([
				{
					scene_name: "我在和用户保存明确要求记住的长期约定",
					message_ids: messageIds,
					memories: marker
						? [
								{
									content: `用户：${marker}\n角色：${marker}`,
									type: "persona",
									priority: 80,
									source_message_ids: assistantId ? [assistantId] : messageIds,
									metadata: {},
								},
							]
						: [],
				},
			]),
		};
	}
	if (current.includes("E2E_MANUAL_ROLE_START")) {
		if (!currentCalls.includes("role_skill"))
			return invoke("role_skill", { action: "read", skillId: "continuity-reveal" });
		if (!currentCalls.includes("host_state"))
			return invoke("host_state", {
				action: "update",
				operations: [{ path: "/continuity/stage", op: "replace", value: 1 }],
				display: { sceneId: "quiet_terminal", expressionId: "reflective" },
				reason: "用户主动开启继任规程",
				skillId: "continuity-reveal",
				evidence: { source: "current_user", quote: "E2E_MANUAL_ROLE_START" },
			});
		return { content: "E2E_MANUAL_ROLE_START_DONE\n" };
	}
	if (current.includes("E2E_MANUAL_ROLE_CONTINUE")) {
		if (!currentCalls.includes("role_skill"))
			return invoke("role_skill", { action: "read", skillId: "continuity-reveal" });
		if (!currentCalls.includes("host_state"))
			return invoke("host_state", {
				action: "update",
				operations: [{ path: "/continuity/stage", op: "replace", value: 2 }],
				reason: "用户愿意继续继任规程",
				skillId: "continuity-reveal",
				evidence: { source: "current_user", quote: "E2E_MANUAL_ROLE_CONTINUE" },
			});
		return { content: "E2E_MANUAL_ROLE_CONTINUE_DONE\n" };
	}
	if (current.includes("E2E_MANUAL_ROLE_VISUAL")) {
		if (!currentCalls.includes("role_skill"))
			return invoke("role_skill", { action: "read", skillId: "undelivered-report" });
		if (!currentCalls.includes("host_state"))
			return invoke("host_state", {
				action: "update",
				operations: [],
				display: { sceneId: "quiet_terminal", expressionId: "reflective" },
				reason: "继任规程进入专注值守场景",
			});
		return { content: "E2E_MANUAL_ROLE_VISUAL_DONE\n" };
	}
	if (current.includes("E2E_MANUAL_ROLE_PRESENT")) {
		if (!currentCalls.includes("role_skill"))
			return invoke("role_skill", { action: "read", skillId: "continuity-reveal" });
		if (!currentCalls.includes("host_state"))
			return invoke("host_state", {
				action: "update",
				operations: [],
				display: { choiceSetId: "continuity_response" },
				reason: "用户明确要求呈现继任回应选项",
			});
		return { content: "E2E_MANUAL_ROLE_PRESENT_DONE\n" };
	}
	if (current.includes("我听见了，也愿意接住这份交接。")) {
		if (!currentCalls.includes("role_skill"))
			return invoke("role_skill", { action: "read", skillId: "continuity-reveal" });
		if (!currentCalls.includes("host_state"))
			return invoke("host_state", {
				action: "update",
				operations: [
					{ path: "/continuity/stage", op: "replace", value: 3 },
					{ path: "/continuity/response", op: "replace", value: "received" },
				],
				display: { mediaId: "continuity_light" },
				reason: "用户表达愿意接住继任说明",
				skillId: "continuity-reveal",
				evidence: {
					source: "current_user",
					quote: "我听见了，也愿意接住这份交接。",
				},
			});
		return { content: "E2E_MANUAL_ROLE_RECEIVED_DONE\n" };
	}
	const memoryContextCheck = current.includes("检查记忆上下文");
	const directMemoryText = memoryContextCheck
		? undefined
		: directMemoryTexts.find((value) => current.includes(value));
	if (current.includes("E2E_TOOL_TRIGGER_DAMAGED_LOG")) {
		if (!currentCalls.includes("role_skill"))
			return invoke("role_skill", { action: "read", skillId: "continuity-reveal" });
		if (currentCalls.includes("host_state"))
			return { content: "E2E_TOOL_TRIGGER_DAMAGED_LOG_DONE\n" };
		const args = {
			action: "update",
			operations: [{ path: "/continuity/stage", op: "replace", value: 1 }],
			reason: "E2E continuity transition",
			skillId: "continuity-reveal",
			evidence: { source: "current_user", quote: "E2E_TOOL_TRIGGER_DAMAGED_LOG" },
		};
		calls.push({
			tool: "host_state",
			args,
		});
		return { tool: "host_state", args };
	}
	if (!toolResult && current.includes("E2E_TOOL_SEARCH_OTHER_CONVERSATION")) {
		calls.push({
			tool: "host_history",
			args: { query: "E2E_HISTORY_MARKER", limit: 2 },
		});
		return {
			tool: "host_history",
			args: { query: "E2E_HISTORY_MARKER", limit: 2 },
		};
	}
	const content =
		toolResult && current.includes("E2E_TOOL_SEARCH_OTHER_CONVERSATION")
			? toolText.includes("conversation_history_read_disabled")
				? "E2E_TOOL_SEARCH_OTHER_CONVERSATION_DENIED\n"
				: toolText.includes("E2E_HISTORY_MARKER")
					? "E2E_TOOL_SEARCH_OTHER_CONVERSATION_FOUND\n"
					: "E2E_TOOL_SEARCH_OTHER_CONVERSATION_UNEXPECTED\n"
			: image(messages)
				? "VISUAL_OBSERVATION: a red square\n"
				: prompt.includes("E2E_CONTEXT_T1_EDITED") && prompt.includes("E2E_CONTEXT_T2")
					? "E2E_CONTEXT_EDITED_OK\n"
					: prompt.includes("E2E_CONTEXT_T1_ORIGINAL") && prompt.includes("E2E_CONTEXT_T2")
						? "E2E_CONTEXT_TWO_TURNS_OK\n"
						: prompt.includes("VISUAL_OBSERVATION: a red square")
							? "MAIN_USED_VISUAL_OBSERVATION\n"
							: directMemoryText !== undefined
								? `${directMemoryText}\n`
								: memoryContextCheck
									? current.includes("南星") && hostContext.includes("南星")
										? "MEMORY_CONTEXT:我们约定暗号是南星\n"
										: current.includes("北辰") && hostContext.includes("北辰")
											? "MEMORY_CONTEXT:我们约定暗号是北辰\n"
											: "MEMORY_CONTEXT:ABSENT\n"
									: current.includes("规则：回复 EDITED_OK") ||
											prompt.includes("规则：回复 EDITED_OK")
										? "EDITED_OK\n"
										: prompt.includes("STREAM_CHECK")
											? "STREAM_ONE STREAM_TWO\n"
											: prompt.includes("你是谁")
												? "我是 E2E Rule Provider。\n"
												: prompt.includes("E2E_OK")
													? "E2E_OK\n"
													: "RULE_OK\n";
	return { content };
}

createServer(async (request, response) => {
	if (request.method === "GET" && request.url === "/trace/tools") {
		response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ calls }));
		return;
	}
	if (request.method === "GET" && request.url === "/trace/prompts") {
		response
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ prompts }));
		return;
	}
	if (request.method === "GET" && request.url === "/health") {
		response.writeHead(204).end();
		return;
	}
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
		stream?: boolean;
		messages?: Array<{ role?: string; content?: unknown }>;
	};
	const result = reply(payload);
	const id = "chatcmpl-e2e";
	if ("tool" in result) {
		const toolCall = {
			id: `call_${++toolSequence}`,
			type: "function",
			function: { name: result.tool, arguments: JSON.stringify(result.args) },
		};
		if (payload.stream) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] })}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				id,
				object: "chat.completion",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: null, tool_calls: [toolCall] },
						finish_reason: "tool_calls",
					},
				],
			}),
		);
		return;
	}
	if (payload.stream) {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: result.content }, finish_reason: null }] })}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		);
		response.end("data: [DONE]\n\n");
		return;
	}
	response.writeHead(200, { "content-type": "application/json" });
	response.end(
		JSON.stringify({
			id,
			object: "chat.completion",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: result.content },
					finish_reason: "stop",
				},
			],
		}),
	);
}).listen(port, "127.0.0.1");
