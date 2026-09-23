import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { AcpProcessSpec } from "../src/executors/acp-client.js";
import { AcpExecutorController } from "../src/executors/acp-executor.js";
import { readAcpRecovery } from "../src/executors/acp-recovery.js";
import { isolatedRunEnvironment } from "../src/executors/environment.js";
import type { ExecutorEvent, ExecutorLaunchRequest } from "../src/executors/router.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "bear-custom-acp-")));
	const workspace = join(root, "workspace");
	const outputDirectory = join(root, "outputs");
	mkdirSync(workspace);
	mkdirSync(outputDirectory);
	cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
	const events: ExecutorEvent[] = [];
	const completion = Promise.withResolvers<void>();
	const request: ExecutorLaunchRequest = {
		run: { runId: "custom-run", triggerEntryId: "entry", executorProfile: "custom-test" },
		profile: { id: "custom-test", type: "custom", capabilities: {} },
		task: { workspace, outputDirectory, instruction: "Wait for further instructions." },
		emit: (event) => {
			events.push(event);
			if (event.type === "completed" || event.type === "failed") completion.resolve();
		},
	};
	class Controller extends AcpExecutorController {
		protected processSpec(): AcpProcessSpec {
			return {
				command: realpathSync(process.execPath),
				args: [fileURLToPath(new URL("./fixtures/acp-custom.mjs", import.meta.url))],
				cwd: workspace,
				env: isolatedRunEnvironment(root, { BEAR_OUTPUT_DIR: outputDirectory }),
			};
		}
	}
	const controller = () => {
		const value = new Controller();
		cleanups.push(() => value.close());
		return value;
	};
	return { request, events, completion, controller };
}
it("restores the same native custom session after proven release, then executes standard file and terminal callbacks", async () => {
	const f = fixture();
	const first = f.controller();
	await first.launch(f.request);
	expect(readAcpRecovery(f.request)?.released).toBe(false);
	expect(await first.suspend()).toEqual(["custom-run"]);
	expect(readAcpRecovery(f.request)?.released).toBe(true);
	const second = f.controller();
	expect(await second.restore(f.request)).toBe("attached");
	expect(second.runtime(f.request.run).actions).toEqual(["cancel", "resume"]);
	await second.resume(f.request.run, undefined, "complete");
	await f.completion.promise;
	expect(f.events).toContainEqual({ type: "restored" });
	expect(f.events).toContainEqual({ type: "completed", summary: undefined });
	expect(readFileSync(join(f.request.task.outputDirectory, "result.txt"), "utf8")).toBe(
		"ACP output",
	);
	expect(f.events).toContainEqual({
		type: "evidence",
		kind: "acp.message",
		data: { text: "ACP output\n" },
	});
}, 15000);
it("never duplicates a worker whose previous controller release is unconfirmed", async () => {
	const f = fixture();
	const first = f.controller();
	await first.launch(f.request);
	expect(await f.controller().restore(f.request)).toBe("unknown");
	expect(f.events.filter((event) => event.type === "started")).toHaveLength(1);
});
