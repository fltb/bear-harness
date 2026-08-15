// @vitest-environment node

import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";

describe("Zod RPC dispatcher", () => {
	it("rejects unknown fields without leaking validation internals", async () => {
		const dispatcher = new Dispatcher();
		dispatcher.registerHandler("settings.get:v1", async () => ({ settings: {} }));

		await expect(dispatcher.dispatch("settings.get:v1", { bypass: true })).resolves.toEqual({
			ok: false,
			error: { kind: "invalid_request", reason: "request_validation_failed" },
		});
	});
});
