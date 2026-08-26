import { createServer, type Server } from "node:http";

interface Message {
	role?: string;
	content?: unknown;
	tool_calls?: Array<{ function?: { name?: string } }>;
}

type Reply = { tool: string; args: Record<string, unknown> } | { content: string };

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(text).join("\n");
	if (value && typeof value === "object") {
		const record = value as { text?: unknown; content?: unknown };
		return text(record.text ?? record.content);
	}
	return "";
}

function currentUserMessage(messages: Message[]): string {
	const latestUser = [...messages].reverse().find((message) => message.role === "user");
	const content = text(latestUser?.content);
	return (
		[...content.matchAll(/<current_user_message>\n([\s\S]*?)<\/current_user_message>/g)].at(
			-1,
		)?.[1] ?? content
	);
}

function currentTurn(messages: Message[]): Message[] {
	const index = messages.findLastIndex((message) => message.role === "user");
	return index < 0 ? messages : messages.slice(index);
}

function calledTools(messages: Message[]): string[] {
	return currentTurn(messages).flatMap((message) =>
		(message.tool_calls ?? []).flatMap((call) => (call.function?.name ? [call.function.name] : [])),
	);
}

function attachmentIds(messages: Message[]): string[] {
	const results = currentTurn(messages)
		.filter((message) => message.role === "tool")
		.map((message) => text(message.content))
		.join("\n");
	return [...results.matchAll(/["'](?:id|attachmentId)["']\s*:\s*["']([0-9a-z-]{8,64})["']/gi)]
		.map((match) => match[1])
		.filter((id, index, ids) => ids.indexOf(id) === index);
}

function scriptedReply(
	messages: Message[],
	calls: Array<{ tool: string; args: Record<string, unknown> }>,
): Reply {
	const current = currentUserMessage(messages);
	const prompt = messages.map((message) => text(message.content)).join("\n");
	const tools = calledTools(messages);
	const choose = (tool: string, args: Record<string, unknown>): Reply => {
		calls.push({ tool, args });
		return { tool, args };
	};
	const roleMarker = current.includes("E2E_DESKTOP_LIVE_RUN")
		? "live"
		: current.includes("E2E_DESKTOP_FALLBACK_RUN")
			? "fallback"
			: undefined;
	if (roleMarker) {
		if (!tools.includes("host_list_attachments")) return choose("host_list_attachments", {});
		const [attachmentId] = attachmentIds(messages);
		if (!attachmentId) return { content: "E2E_DESKTOP_FIXTURE_MISSING_ATTACHMENT_ID\n" };
		if (!tools.includes("host_read_attachment")) {
			return choose("host_read_attachment", { attachmentId, query: "desktop source marker" });
		}
		if (!tools.includes("host_delegate_agent")) {
			const marker =
				roleMarker === "live" ? "E2E_DESKTOP_EXTERNAL_LIVE" : "E2E_DESKTOP_EXTERNAL_FALLBACK";
			return choose("host_delegate_agent", {
				agent: "pi",
				attachmentIds: [attachmentId],
				workspaceAttachmentId: attachmentId,
				instruction: `${marker}: modify the selected workspace and write the requested report beneath BEAR_OUTPUT_DIR.`,
			});
		}
		return { content: `E2E_DESKTOP_${roleMarker.toUpperCase()}_STARTED\n` };
	}

	if (
		current.includes("E2E_DESKTOP_EXTERNAL_LIVE") ||
		prompt.includes("E2E_DESKTOP_EXTERNAL_LIVE")
	) {
		if (!tools.includes("bash")) {
			return choose("bash", {
				command:
					"printf 'modified through live source grant\\n' > ./live-result.txt && mkdir -p \"$BEAR_OUTPUT_DIR\" && printf 'live source run complete\\n' > \"$BEAR_OUTPUT_DIR/live-report.txt\"",
			});
		}
		return { content: "Modified the live workspace and created live-report.txt.\n" };
	}

	if (
		current.includes("E2E_DESKTOP_EXTERNAL_FALLBACK") ||
		prompt.includes("E2E_DESKTOP_EXTERNAL_FALLBACK")
	) {
		if (!tools.includes("bash")) {
			return choose("bash", {
				command:
					"printf 'modified only in immutable fallback\\n' > ./snapshot-result.txt && mkdir -p \"$BEAR_OUTPUT_DIR\" && printf 'immutable snapshot fallback complete\\n' > \"$BEAR_OUTPUT_DIR/fallback-report.txt\"",
			});
		}
		return { content: "Used the immutable snapshot fallback and created fallback-report.txt.\n" };
	}

	return { content: "DESKTOP_ATTACHMENT_RULE_OK\n" };
}

export async function startAttachmentAgentProvider(): Promise<{
	baseUrl: string;
	calls: Array<{ tool: string; args: Record<string, unknown> }>;
	close(): Promise<void>;
}> {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	let sequence = 0;
	const server: Server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
			stream?: boolean;
			messages?: Message[];
		};
		const result = scriptedReply(payload.messages ?? [], calls);
		const id = "chatcmpl-desktop-attachment-e2e";
		if ("tool" in result) {
			const toolCall = {
				id: `call_${++sequence}`,
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
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("desktop fixture did not bind TCP");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		calls,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
