// @vitest-environment node

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type AcpProcessSpec, AcpRunClient } from "../src/executors/acp-client.js";
import { AcpExecutorController } from "../src/executors/acp-executor.js";
import type { ExecutorLaunchRequest } from "../src/executors/router.js";

const fixturePath = realpathSync.native(
	fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url)),
);
const executablePath = realpathSync.native(process.execPath);
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTemp(purpose: "workspace" | "home"): string {
	const directory = mkdtempSync(join(realpathSync.native(tmpdir()), `bear-acp-${purpose}-`));
	temporaryDirectories.push(directory);
	return directory;
}

function fixtureSpec(
	cwd: string,
	permission = false,
	environment: NodeJS.ProcessEnv = {},
): AcpProcessSpec {
	return {
		command: executablePath,
		args: [fixturePath],
		cwd: realpathSync.native(cwd),
		env: {
			PATH: process.env.PATH,
			HOME: createTemp("home"),
			FIXTURE_PERMISSION: permission ? "1" : "0",
			...environment,
		},
	};
}

class FixtureController extends AcpExecutorController {
	constructor(
		private readonly permission = false,
		private readonly environment: NodeJS.ProcessEnv = {},
	) {
		super();
	}

	protected processSpec(request: ExecutorLaunchRequest): AcpProcessSpec {
		return fixtureSpec(request.task.workspace, this.permission, this.environment);
	}
}

describe("ACP external-agent transport", () => {
	it("performs initialize, session creation, prompt, and a user-resolved permission request", async () => {
		const cwd = createTemp("workspace");
		const permission = Promise.withResolvers<{ requestId: string; optionId: string }>();
		const updates: string[] = [];
		const client = new AcpRunClient(fixtureSpec(cwd, true), {
			onSessionUpdate: (notification) => updates.push(notification.update.sessionUpdate),
			onPermissionRequest: (request) =>
				permission.resolve({ requestId: request.requestId, optionId: "allow" }),
			onExit: () => undefined,
		});

		expect(client.recoveryState()).toBe("unknown");
		await client.start();
		expect(client.recoveryState()).toBe("attached");
		const prompt = client.prompt("Inspect the file.");
		const approval = await permission.promise;
		client.respondToPermission(approval.requestId, approval.optionId);
		await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
		await client.stop();

		expect(client.activeSessionId).toBeNull();
		expect(client.recoveryState()).toBe("confirmed_lost");
		expect(updates).toEqual(["tool_call", "tool_call_update"]);
	});

	it("converts ACP updates into Host lifecycle and evidence events", async () => {
		const cwd = createTemp("workspace");
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

	it("drains worker stderr without exposing credentials in exit results or failure events", async () => {
		const cwd = createTemp("workspace");
		const secret = "pi-secret-must-not-persist";
		const exit = Promise.withResolvers<{
			code: number | null;
			signal: NodeJS.Signals | null;
			errorCode?: string;
		}>();
		const client = new AcpRunClient(
			fixtureSpec(cwd, false, {
				BEAR_PI_API_KEY: secret,
				FIXTURE_STDERR_EXIT_CODE: "23",
			}),
			{
				onSessionUpdate: () => undefined,
				onPermissionRequest: () => undefined,
				onExit: exit.resolve,
			},
		);

		await client.start();
		let promptFailure: unknown;
		try {
			await client.prompt("Fail after writing stderr.");
		} catch (error) {
			promptFailure = error;
		}
		const exitResult = await exit.promise;
		await client.stop();

		expect(exitResult).toEqual({ code: 23, signal: null });
		expect(JSON.stringify({ exitResult, promptFailure })).not.toContain(secret);

		const events: Array<{ type: string; [key: string]: unknown }> = [];
		const failed = Promise.withResolvers<void>();
		const controller = new FixtureController(false, {
			BEAR_PI_API_KEY: secret,
			FIXTURE_STDERR_EXIT_CODE: "23",
		});
		await controller.launch({
			run: { runId: "run-secret", triggerEntryId: "entry-secret", executorProfile: "pi-worker" },
			task: { instruction: "Fail safely.", workspace: cwd },
			profile: { id: "pi-worker", type: "pi", capabilities: {} },
			emit: (event) => {
				events.push(event);
				if (event.type === "failed") failed.resolve();
			},
		});
		await failed.promise;
		await controller.close();
		const failure = events.find((event) => event.type === "failed");
		expect(failure?.reason).toMatch(/^(?:acp_agent_exit_code:23|acp_executor_failed)$/);
		expect(JSON.stringify(events)).not.toContain(secret);
	});

	it("reports only a real live handle as attached and fails closed after restart", async () => {
		const cwd = createTemp("workspace");
		const controller = new FixtureController(true);
		const permissionRequested = Promise.withResolvers<void>();
		const request: ExecutorLaunchRequest = {
			run: { runId: "run-close", triggerEntryId: "entry-close", executorProfile: "pi-worker" },
			task: { instruction: "Wait for permission.", workspace: cwd },
			profile: { id: "pi-worker", type: "pi", capabilities: {} },
			emit: (event) => {
				if (event.type === "needs_user") permissionRequested.resolve();
			},
		};
		await controller.launch(request);
		await permissionRequested.promise;
		expect(await controller.recover(request.run)).toBe("attached");

		// A newly constructed controller models Host restart. It cannot inherit
		// this anonymous stdio handle, but that absence is not proof of process
		// loss and must never become confirmed_lost.
		const restartedController = new FixtureController(true);
		expect(await restartedController.recover(request.run)).toBe("unknown");
		await controller.close();
		expect(await controller.recover(request.run)).toBe("unknown");
		await restartedController.close();
	});
});
