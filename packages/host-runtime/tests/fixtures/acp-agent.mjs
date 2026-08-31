#!/usr/bin/env node

let buffer = "";
let promptId = null;
let permissionId = null;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const boundary = buffer.indexOf("\n");
		if (boundary < 0) return;
		const line = buffer.slice(0, boundary).replace(/\r$/, "");
		buffer = buffer.slice(boundary + 1);
		if (line) handle(JSON.parse(line));
	}
});

function send(message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function finish(stopReason = "end_turn") {
	if (promptId === null) return;
	send({
		method: "session/update",
		params: {
			sessionId: "fixture-session",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status: stopReason === "cancelled" ? "failed" : "completed",
			},
		},
	});
	send({ id: promptId, result: { stopReason } });
	promptId = null;
}

function handle(message) {
	if (message.method === "initialize") {
		send({
			id: message.id,
			result: {
				protocolVersion: 1,
				agentCapabilities: { loadSession: false },
				agentInfo: { name: "fixture", version: "1" },
			},
		});
		return;
	}
	if (message.method === "session/new") {
		send({ id: message.id, result: { sessionId: "fixture-session" } });
		return;
	}
	if (message.method === "session/prompt") {
		promptId = message.id;
		if (process.env.FIXTURE_STDERR_EXIT_CODE) {
			process.stderr.write(`worker failed: ${process.env.BEAR_PI_API_KEY ?? "missing-key"}\n`);
			process.exit(Number(process.env.FIXTURE_STDERR_EXIT_CODE));
		}
		send({
			method: "session/update",
			params: {
				sessionId: "fixture-session",
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "tool-1",
					title: "Read approved file",
					kind: "read",
					status: "in_progress",
				},
			},
		});
		if (process.env.FIXTURE_PERMISSION === "1") {
			permissionId = "agent-permission-1";
			send({
				id: permissionId,
				method: "session/request_permission",
				params: {
					sessionId: "fixture-session",
					toolCall: {
						toolCallId: "tool-1",
						title: "Write approved file",
						kind: "edit",
						status: "pending",
					},
					options: [
						{ optionId: "allow", kind: "allow_once", name: "Allow once" },
						{ optionId: "deny", kind: "reject_once", name: "Deny" },
					],
				},
			});
		} else {
			finish();
		}
		return;
	}
	if (message.id === permissionId) {
		permissionId = null;
		finish();
		return;
	}
	if (message.method === "session/cancel") {
		finish("cancelled");
	}
	if (message.method === "_session/steering") {
		// Unregistered extension methods are rejected like the ACP SDK does.
		send({
			id: message.id,
			error: {
				code: -32601,
				message: "Method not found",
				data: { method: "_session/steering" },
			},
		});
	}
}
