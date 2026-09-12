import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CharacterTrace } from "../src/diagnostics/character-trace.js";
import { BearHarnessHostAdapter } from "../src/memory/tencentdb-host-adapter.js";

it("records the real memory model failure and rejects error-valued assistant messages", async () => {
	const root = await mkdtemp(join(tmpdir(), "bear-memory-model-trace-"));
	const diagnostics = new CharacterTrace(root, "role-a");
	const completeSimple = vi.fn(async () => ({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "fetch failed",
	}));
	const adapter = new BearHarnessHostAdapter({
		dataDir: root,
		companionId: "role-a",
		userId: "user-a",
		models: {} as never,
		providers: {
			getModels: async () => ({
				getModel: () => ({ provider: "fixture", id: "model" }),
				completeSimple,
			}),
		} as never,
		diagnostics,
	});
	try {
		const runner = adapter
			.getLLMRunnerFactory()
			.createRunner({ modelRef: "fixture/model", enableTools: false });
		await expect(
			runner.run({ taskId: "l1-extraction", prompt: "private extraction input" }),
		).rejects.toThrow("fetch failed");
		expect(completeSimple).toHaveBeenCalledOnce();
		const [trace] = await diagnostics.list();
		if (!trace) throw new Error("missing model trace");
		const exported = JSON.parse(await diagnostics.exportTrace(trace.traceId));
		expect(exported.events.at(-1)).toMatchObject({
			event: "memory.model.end",
			attributes: { outcome: "error", error: { message: "fetch failed" } },
		});
		expect(JSON.stringify(exported.payloads)).toContain("private extraction input");
		expect(exported.completeness.openSpans).toBe(0);
	} finally {
		await diagnostics.close();
		await rm(root, { recursive: true, force: true });
	}
});
