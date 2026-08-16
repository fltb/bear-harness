import { createCompanionClient } from "@bear-harness/companion-client";
import { describe, expect, it, vi } from "vitest";

describe("schema-derived companion client", () => {
	it("uses endpoint objects and rejects malformed Host success data", async () => {
		const invoke = vi.fn(async () => ({ ok: true, data: { entries: [{ id: "missing-fields" }] } }));
		const client = createCompanionClient({ invoke });

		await expect(client.memory.search({ query: "remember" })).rejects.toMatchObject({
			name: "ZodError",
		});
		expect(invoke.mock.calls[0]?.[0]).toMatchObject({
			kind: "rpc",
			channel: "memory.search:v1",
		});
	});

	it("rejects invalid requests before transport invocation", async () => {
		const invoke = vi.fn();
		const client = createCompanionClient({ invoke });
		await expect(
			client.memory.search({ query: "test", scope: "invalid" as never }),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(invoke).not.toHaveBeenCalled();
	});
});
