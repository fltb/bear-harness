#!/usr/bin/env node

// ACP agent fixture for mid-run control tests (steer / interrupt / resume).
// The first session/prompt is held open until session/cancel; a subsequent
// prompt (resume) finishes immediately. `_session/steering` is answered
// directly so the Host steer path is exercised end to end.

let buffer = "";
let promptId = null;
let paused = false;

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
				agentInfo: { name: "controls-fixture", version: "1" },
			},
		});
		return;
	}
	if (message.method === "session/new") {
		send({ id: message.id, result: { sessionId: "fixture-session" } });
		return;
	}
	if (message.method === "session/prompt") {
		if (paused) {
			// Resume after an interrupt: the session survives, so a fresh
			// prompt completes the run.
			paused = false;
			send({ id: message.id, result: { stopReason: "end_turn" } });
			return;
		}
		if (promptId !== null) {
			// A prompt is already in flight; the controls fixture only holds one.
			send({
				id: message.id,
				error: { code: -32603, message: "prompt already active", data: {} },
			});
			return;
		}
		promptId = message.id;
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
		// Hold the first prompt open: finish() only runs on session/cancel.
		return;
	}
	if (message.method === "_session/steering") {
		send({ id: message.id, result: { outcome: "injected" } });
		return;
	}
	if (message.method === "session/cancel") {
		paused = true;
		finish("cancelled");
	}
}
