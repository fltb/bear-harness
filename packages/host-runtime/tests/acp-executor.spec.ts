// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type AcpProcessSpec, AcpRunClient } from "../src/executors/acp-client.js";
import { AcpExecutorController } from "../src/executors/acp-executor.js";
import type { ExecutorLaunchRequest } from "../src/executors/router.js";

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
		return fixtureSpec(request.task.workspace);
	}
}

describe("ACP external-agent transport", () => {
	it("performs initialize, session creation, prompt, and a user-resolved permission request", async () => {
		const cwd = createTemp();
		const permission = Promise.withResolvers<{ requestId: string; optionId: string }>();
		const updates: string[] = [];
		const client = new AcpRunClient(fixtureSpec(cwd, true), {
			onSessionUpdate: (notification) => updates.push(notification.update.sessionUpdate),
			onPermissionRequest: (request) =>
				permission.resolve({ requestId: request.requestId, optionId: "allow" }),
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
			run: { runId: "run-1", triggerEntryId: "entry-1", executorProfile: "pi-worker" },
			task: { instruction: "Inspect the workspace.", workspace: cwd },
			profile: { id: "pi-worker", type: "pi", capabilities: {} },
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
});
