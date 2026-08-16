// @vitest-environment node

import { RPC } from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";
import { Dispatcher, ProtocolResponseValidationError } from "../src/dispatcher.js";

describe("Zod RPC dispatcher", () => {
	it("rejects unknown fields without leaking validation internals", async () => {
		const dispatcher = new Dispatcher();
		dispatcher.registerHandler(RPC.settings.get, async () => ({ settings: {} }));

		await expect(dispatcher.dispatch("settings.get:v1", { bypass: true })).resolves.toEqual({
			ok: false,
			error: { kind: "invalid_request", reason: "request_validation_failed" },
		});
	});

	it("fails closed when a handler returns incomplete success data", async () => {
		const dispatcher = new Dispatcher();
		dispatcher.registerHandler(RPC.memory.search, (async () => ({
			entries: [{ id: "missing-required-fields" }],
		})) as never);

		await expect(
			dispatcher.dispatch(RPC.memory.search.channel, { query: "test" }),
		).rejects.toBeInstanceOf(ProtocolResponseValidationError);
	});

	it("isolates malformed responses in production mode", async () => {
		const dispatcher = new Dispatcher({ responseValidation: "isolate" });
		dispatcher.registerHandler(RPC.message.send, (async () => ({
			messageId: "only-one-field",
		})) as never);
		await expect(
			dispatcher.dispatch(RPC.message.send.channel, { conversationId: "c1", text: "hello" }),
		).resolves.toEqual({
			ok: false,
			error: { kind: "internal", reason: "response_validation_failed" },
		});
	});
});
