import { createServer } from "node:http";

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

function reply(payload: { messages?: Array<{ role?: string; content?: unknown }> }) {
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
	const toolResult = afterUser.some((message) => message.role === "tool");
	const toolText = afterUser
		.filter((message) => message.role === "tool")
		.map((message) => text(message.content))
		.join("\n");
	if (!toolResult && current.includes("E2E_TOOL_TRIGGER_DAMAGED_LOG")) {
		calls.push({
			tool: "host_trigger_roleplay_event",
			args: { eventId: "first_meeting_remembered" },
		});
		return { tool: "host_trigger_roleplay_event", args: { eventId: "first_meeting_remembered" } };
	}
	if (!toolResult && current.includes("E2E_TOOL_SEARCH_OTHER_CONVERSATION")) {
		calls.push({
			tool: "host_search_conversation_history",
			args: { query: "E2E_HISTORY_MARKER", limit: 2 },
		});
		return {
			tool: "host_search_conversation_history",
			args: { query: "E2E_HISTORY_MARKER", limit: 2 },
		};
	}
	const content =
		toolResult && current.includes("E2E_TOOL_TRIGGER_DAMAGED_LOG")
			? "E2E_TOOL_TRIGGER_DAMAGED_LOG_DONE\n"
			: toolResult && current.includes("E2E_TOOL_SEARCH_OTHER_CONVERSATION")
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
								: current.includes("检查记忆上下文")
									? current.includes("南星") && hostContext.includes("南星")
										? "MEMORY_CONTEXT:我们约定暗号是南星\n"
										: current.includes("北辰") && hostContext.includes("北辰")
											? "MEMORY_CONTEXT:我们约定暗号是北辰\n"
											: "MEMORY_CONTEXT:ABSENT\n"
									: prompt.includes("EDITED_OK")
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
