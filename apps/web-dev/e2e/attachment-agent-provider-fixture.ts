export interface FixtureMessage {
	role?: string;
	content?: unknown;
	tool_calls?: Array<{ function?: { name?: string } }>;
}

export type FixtureReply = { tool: string; args: Record<string, unknown> } | { content: string };

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(text).join("\n");
	if (value && typeof value === "object") {
		const record = value as { text?: unknown; content?: unknown };
		return text(record.text ?? record.content);
	}
	return "";
}

function currentUserMessage(messages: FixtureMessage[]): string {
	const latestUser = [...messages].reverse().find((message) => message.role === "user");
	const content = text(latestUser?.content);
	return (
		[...content.matchAll(/<current_user_message>\n([\s\S]*?)<\/current_user_message>/g)].at(
			-1,
		)?.[1] ?? content
	);
}

function currentTurn(messages: FixtureMessage[]): FixtureMessage[] {
	const index = messages.findLastIndex((message) => message.role === "user");
	return index < 0 ? messages : messages.slice(index);
}

function calledTools(messages: FixtureMessage[]): string[] {
	return currentTurn(messages).flatMap((message) =>
		(message.tool_calls ?? []).flatMap((call) => (call.function?.name ? [call.function.name] : [])),
	);
}

function toolResults(messages: FixtureMessage[]): string {
	return currentTurn(messages)
		.filter((message) => message.role === "tool")
		.map((message) => text(message.content))
		.join("\n");
}

function attachmentIds(value: string): string[] {
	return [...value.matchAll(/["'](?:id|attachmentId)["']\s*:\s*["']([0-9a-z-]{8,64})["']/gi)]
		.map((match) => match[1])
		.filter((id, index, ids) => ids.indexOf(id) === index);
}

function tool(
	name: string,
	args: Record<string, unknown>,
	record: (name: string, args: Record<string, unknown>) => void,
): FixtureReply {
	record(name, args);
	return { tool: name, args };
}

/** Deterministic role-Pi and external-Pi script for the attachment E2E journey. */
export function attachmentAgentReply(
	messages: FixtureMessage[],
	record: (name: string, args: Record<string, unknown>) => void,
): FixtureReply | undefined {
	const current = currentUserMessage(messages);
	const prompt = messages.map((message) => text(message.content)).join("\n");
	const calls = calledTools(messages);

	if (current.includes("E2E_WEB_ATTACHMENT_AGENT_JOURNEY")) {
		if (!calls.includes("host_list_attachments")) {
			return tool("host_list_attachments", {}, record);
		}
		const ids = attachmentIds(toolResults(messages));
		if (calls.filter((name) => name === "host_read_attachment").length === 0) {
			if (!ids[0]) return { content: "E2E_ATTACHMENT_FIXTURE_MISSING_FILE_ID\n" };
			return tool("host_read_attachment", { attachmentId: ids[0] }, record);
		}
		if (calls.filter((name) => name === "host_read_attachment").length === 1) {
			if (!ids[1]) return { content: "E2E_ATTACHMENT_FIXTURE_MISSING_FOLDER_ID\n" };
			return tool(
				"host_read_attachment",
				{ attachmentId: ids[1], query: "alpha folder marker" },
				record,
			);
		}
		if (!calls.includes("host_delegate_agent")) {
			if (!ids[0] || !ids[1]) return { content: "E2E_ATTACHMENT_FIXTURE_MISSING_DELEGATE_IDS\n" };
			return tool(
				"host_delegate_agent",
				{
					agent: "pi",
					attachmentIds: [ids[0], ids[1]],
					workspaceAttachmentId: ids[1],
					instruction:
						"E2E_WEB_EXTERNAL_RUN: inspect the supplied immutable snapshots and create generated-report.txt beneath BEAR_OUTPUT_DIR.",
				},
				record,
			);
		}
		return { content: "E2E_WEB_ATTACHMENT_AGENT_STARTED\n" };
	}

	if (current.includes("E2E_WEB_EXTERNAL_RUN") || prompt.includes("E2E_WEB_EXTERNAL_RUN")) {
		if (!calls.includes("bash")) {
			return tool(
				"bash",
				{
					command:
						'mkdir -p "$BEAR_OUTPUT_DIR" && printf \'generated from immutable web attachments\\n\' > "$BEAR_OUTPUT_DIR/generated-report.txt"',
				},
				record,
			);
		}
		return {
			content: "Created generated-report.txt from the supplied conversation attachments.\n",
		};
	}

	return undefined;
}
