import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const sessionId = "custom-session";
const send = (message) =>
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Map();
let sequence = 0;
let prompt;
function request(method, params) {
	const id = `client-${++sequence}`;
	send({ id, method, params: { sessionId, ...params } });
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
createInterface({ input: process.stdin }).on("line", async (line) => {
	const message = JSON.parse(line);
	if (!message.method) {
		const task = pending.get(message.id);
		pending.delete(message.id);
		message.error ? task?.reject(message.error) : task?.resolve(message.result);
		return;
	}
	const result = (value) => send({ id: message.id, result: value });
	try {
		if (message.method === "initialize") {
			if (
				!message.params.clientCapabilities.fs?.writeTextFile ||
				!message.params.clientCapabilities.terminal
			)
				throw new Error("Missing client capabilities");
			result({
				protocolVersion: 1,
				agentCapabilities: { sessionCapabilities: { resume: {} } },
				agentInfo: { name: "Custom fixture", version: "1" },
			});
		} else if (message.method === "session/new") {
			writeFileSync(join(process.env.HOME, "session-id"), sessionId);
			result({ sessionId });
		} else if (message.method === "session/resume") {
			if (readFileSync(join(process.env.HOME, "session-id"), "utf8") !== message.params.sessionId)
				throw new Error("Wrong native session");
			result({});
		} else if (message.method === "session/prompt") {
			prompt = message.id;
			if (message.params.prompt[0].text.includes("complete")) {
				await request("fs/write_text_file", {
					path: join(process.env.BEAR_OUTPUT_DIR, "result.txt"),
					content: "ACP output",
				});
				const file = await request("fs/read_text_file", {
					path: join(process.env.BEAR_OUTPUT_DIR, "result.txt"),
				});
				const terminal = await request("terminal/create", {
					command: "/bin/echo",
					args: [file.content],
				});
				await request("terminal/wait_for_exit", terminal);
				const output = await request("terminal/output", terminal);
				await request("terminal/release", terminal);
				send({
					method: "session/update",
					params: {
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: output.output },
						},
					},
				});
				result({ stopReason: "end_turn" });
			}
		} else if (message.method === "session/cancel" && prompt !== undefined)
			send({ id: prompt, result: { stopReason: "cancelled" } });
	} catch {
		if (message.id !== undefined)
			send({ id: message.id, error: { code: -32603, message: "fixture failure" } });
	}
});
