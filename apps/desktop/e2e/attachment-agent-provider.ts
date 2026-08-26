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
	const snapshotRun = current.includes("E2E_DESKTOP_SNAPSHOT_RUN");
	if (snapshotRun) {
		if (!tools.includes("host_list_attachments")) return choose("host_list_attachments", {});
		const [attachmentId] = attachmentIds(messages);
		if (!attachmentId) return { content: "E2E_DESKTOP_FIXTURE_MISSING_ATTACHMENT_ID\n" };
		if (!tools.includes("host_read_attachment")) {
			return choose("host_read_attachment", { attachmentId, query: "desktop source marker" });
		}
		if (!tools.includes("host_delegate_agent")) {
			return choose("host_delegate_agent", {
				agent: "pi",
				attachmentIds: [attachmentId],
				workspaceAttachmentId: attachmentId,
				instruction:
					"E2E_DESKTOP_EXTERNAL_SNAPSHOT: verify the immutable selected-folder snapshot and write the report beneath BEAR_OUTPUT_DIR.",
			});
		}
		return { content: "E2E_DESKTOP_SNAPSHOT_STARTED\n" };
	}

	if (
		current.includes("E2E_DESKTOP_EXTERNAL_SNAPSHOT") ||
		prompt.includes("E2E_DESKTOP_EXTERNAL_SNAPSHOT")
	) {
		if (!tools.includes("bash")) {
			return choose("bash", {
				command:
					'set -eu; [ -x /bin/pwd ] || exit 40; [ -x /bin/cat ] || exit 44; case "$PWD" in /*) ;; *) exit 41 ;; esac; case "$HOME" in /*) ;; *) exit 45 ;; esac; case "$BEAR_OUTPUT_DIR" in /*) ;; *) exit 42 ;; esac; workspace_canonical=$(/bin/pwd -P); home_canonical=$(cd -- "$HOME" && /bin/pwd -P); output_canonical=$(cd -- "$BEAR_OUTPUT_DIR" && /bin/pwd -P); [ "$workspace_canonical" = "$PWD" ]; [ "$home_canonical" = "$HOME" ]; [ "$output_canonical" = "$BEAR_OUTPUT_DIR" ]; [ "$workspace_canonical" != "$output_canonical" ]; [ "$home_canonical" != "$output_canonical" ]; [ -f ./source.txt ]; [ -f ./nested/preserved.txt ]; denial_exit=0; printf \'confinement escape\\n\' > ./confinement-escape.txt 2>/dev/null || denial_exit=$?; [ "$denial_exit" -ne 0 ] || exit 43; { printf \'generated from immutable desktop snapshot\\nworkspace=%s\\noutput=%s\\nworkspace_write_denied=true\\n\' "$workspace_canonical" "$output_canonical"; /bin/cat ./source.txt ./nested/preserved.txt; } > "$BEAR_OUTPUT_DIR/snapshot-report.txt"',
			});
		}
		return { content: "Verified the immutable snapshot and created snapshot-report.txt.\n" };
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
