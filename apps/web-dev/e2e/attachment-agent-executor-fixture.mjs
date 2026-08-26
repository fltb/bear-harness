#!/usr/bin/env node

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

let buffer = "";
let cwd;

function send(message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function requireAbsoluteDirectory(name, value) {
	if (!value || !isAbsolute(value)) throw new Error(`${name} must be absolute`);
	if (!statSync(value).isDirectory()) throw new Error(`${name} must be a directory`);
	return resolve(value);
}

function isWithin(candidate, parent) {
	const child = relative(parent, candidate);
	return (
		child === "" ||
		(child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
	);
}

function inputEntries(prompt) {
	return [...prompt.matchAll(/^- (.*?): (.+) \(immutable snapshot copy\)$/gm)].map((match) => ({
		name: match[1],
		path: match[2],
	}));
}

function completePrompt(message) {
	const prompt = (message.params?.prompt ?? [])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	const workspace = requireAbsoluteDirectory("workspace", cwd);
	const home = requireAbsoluteDirectory("HOME", process.env.HOME);
	const output = requireAbsoluteDirectory("BEAR_OUTPUT_DIR", process.env.BEAR_OUTPUT_DIR);
	const suppliedInputs = inputEntries(prompt);
	if (suppliedInputs.length !== 2 || suppliedInputs.some((input) => !isAbsolute(input.path))) {
		throw new Error("expected two absolute immutable snapshot inputs");
	}
	const fileRoot = requireAbsoluteDirectory(
		"single-note.txt snapshot",
		suppliedInputs.find((input) => input.name === "single-note.txt")?.path,
	);
	const folder = requireAbsoluteDirectory(
		"web-folder snapshot",
		suppliedInputs.find((input) => input.name === "web-folder")?.path,
	);
	const inputs = [fileRoot, folder];
	if (workspace !== folder) throw new Error("workspace must be the folder snapshot");
	if (
		[output, home].some((writablePath) =>
			inputs.some((input) => isWithin(writablePath, input) || isWithin(input, writablePath)),
		)
	) {
		throw new Error("writable paths must remain outside the immutable snapshots");
	}
	if (isWithin(output, home) || isWithin(home, output)) {
		throw new Error("HOME and BEAR_OUTPUT_DIR must be distinct");
	}
	if (
		readFileSync(join(fileRoot, "single-note.txt"), "utf8") !== "single file marker: glacier-17\n"
	) {
		throw new Error("single-file snapshot mismatch");
	}
	if (readFileSync(join(folder, "alpha.txt"), "utf8") !== "alpha folder marker: aurora-29\n") {
		throw new Error("folder snapshot mismatch");
	}
	if (
		readFileSync(join(folder, "nested", "beta.md"), "utf8") !==
		"# Nested fixture\n\nbeta folder marker: cedar-43\n"
	) {
		throw new Error("nested folder snapshot mismatch");
	}
	writeFileSync(join(home, ".attachment-fixture-state"), "isolated external-agent home\n", {
		encoding: "utf8",
		mode: 0o600,
	});
	writeFileSync(
		join(output, "generated-report.txt"),
		"generated from immutable web attachments\n",
		{
			encoding: "utf8",
			mode: 0o600,
		},
	);
	send({
		method: "session/update",
		params: {
			sessionId: "attachment-fixture-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: "Created generated-report.txt from the supplied immutable snapshots.",
				},
			},
		},
	});
	send({ id: message.id, result: { stopReason: "end_turn" } });
}

function handle(message) {
	try {
		if (message.method === "initialize") {
			send({
				id: message.id,
				result: {
					protocolVersion: message.params?.protocolVersion ?? 1,
					agentCapabilities: { loadSession: false },
					agentInfo: { name: "web-attachment-fixture", version: "1" },
				},
			});
			return;
		}
		if (message.method === "session/new") {
			cwd = requireAbsoluteDirectory("workspace", message.params?.cwd);
			send({ id: message.id, result: { sessionId: "attachment-fixture-session" } });
			return;
		}
		if (message.method === "session/prompt") {
			completePrompt(message);
			return;
		}
		if (message.method === "session/cancel") return;
		if (message.id !== undefined) {
			send({ id: message.id, error: { code: -32601, message: "Method not found" } });
		}
	} catch (error) {
		if (message.id !== undefined) {
			send({
				id: message.id,
				error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
			});
		}
	}
}

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
