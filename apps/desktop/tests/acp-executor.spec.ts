// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpExecutorController, ApprovedFileAccess } from "../src/main/executors/acp-executor.js";
import { AcpRunClient, type AcpProcessSpec } from "../src/main/executors/acp-client.js";
import type { ExecutorLaunchRequest } from "../src/main/executors/router.js";

const fixturePath = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTemp(): string {
	const directory = mkdtempSync(join(tmpdir(), "bear-acp-"));
	temporaryDirectories.push(directory);
	return directory;
}

function fixtureSpec(cwd: string, permission = false): AcpProcessSpec {
	return {
		command: process.execPath,
		args: [fixturePath],
		cwd,
		env: { PATH: process.env.PATH, FIXTURE_PERMISSION: permission ? "1" : "0" },
	};
}

class FixtureController extends AcpExecutorController {
	protected processSpec(request: ExecutorLaunchRequest): AcpProcessSpec {
		return fixtureSpec(request.commission.reads[0] ?? process.cwd());
	}
}

describe("ACP commission transport", () => {
	it("performs initialize, session creation, prompt, and a user-resolved permission request", async () => {
		const cwd = createTemp();
		const permission = Promise.withResolvers<{ requestId: string; optionId: string }>();
		const updates: string[] = [];
		const client = new AcpRunClient(fixtureSpec(cwd, true), {
			onSessionUpdate: (notification) => updates.push(notification.update.sessionUpdate),
			onPermissionRequest: (request) => permission.resolve({ requestId: request.requestId, optionId: "allow" }),
			onExit: () => undefined,
		});

		await client.start();
		const prompt = client.prompt("Inspect the file.");
		const approval = await permission.promise;
		client.respondToPermission(approval.requestId, approval.optionId);
		await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
		await client.stop();

		expect(client.activeSessionId).toBeNull();
		expect(updates).toEqual(["tool_call", "tool_call_update"]);
	});

	it("converts ACP updates into Host lifecycle and evidence events", async () => {
		const cwd = createTemp();
		const events: Array<{ type: string; [key: string]: unknown }> = [];
		const completed = Promise.withResolvers<void>();
		const controller = new FixtureController();
		const request: ExecutorLaunchRequest = {
			run: { runId: "run-1", commissionId: "commission-1", executorProfile: "pi-worker" },
			commission: {
				id: "commission-1",
				title: "Inspect",
				description: "Inspect the approved root.",
				reads: [cwd],
				writes: [],
				networkAllowed: false,
				toolNames: ["read"],
			},
			profile: { id: "pi-worker", type: "product-managed", capabilities: {} },
			emit: (event) => {
				events.push(event);
				if (event.type === "completed") completed.resolve();
			},
		};

		await controller.launch(request);
		await completed.promise;

		expect(events).toEqual(
			expect.arrayContaining([
				{ type: "started" },
				expect.objectContaining({ type: "evidence", kind: "acp.tool_call" }),
				{ type: "completed", summary: undefined },
			]),
		);
	});

	it("allows only declared files and rejects a symlink that escapes them", async () => {
		const root = createTemp();
		const outside = createTemp();
		const allowed = join(root, "allowed.txt");
		const escaped = join(outside, "secret.txt");
		writeFileSync(allowed, "one\ntwo\nthree\n");
		writeFileSync(escaped, "outside");
		symlinkSync(escaped, join(root, "escape.txt"));
		const evidence: Array<{ kind: string; data: Record<string, unknown> }> = [];
		const files = new ApprovedFileAccess({
			reads: [root],
			writes: [root],
			record: (kind, data) => evidence.push({ kind, data }),
		});

		await expect(
			files.readTextFile({ sessionId: "session", path: allowed, line: 2, limit: 1 }),
		).resolves.toEqual({ content: "two" });
		await expect(files.readTextFile({ sessionId: "session", path: join(root, "escape.txt") })).rejects.toThrow(
			"approved_path_symlink_escape",
		);
		await files.writeTextFile({ sessionId: "session", path: join(root, "output.txt"), content: "done" });

		expect(readFileSync(join(root, "output.txt"), "utf8")).toBe("done");
		expect(evidence.map((entry) => entry.kind)).toEqual(["acp.file_read", "acp.file_write"]);
		expect(dirname(allowed)).toBe(root);
	});
});
