// @vitest-environment node

import { RPC } from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";
import { Dispatcher, ProtocolResponseValidationError } from "../src/dispatcher.js";

describe("Zod RPC dispatcher", () => {
	it("rejects unknown endpoint registration before dispatch", () => {
		const dispatcher = new Dispatcher();

		expect(() =>
			dispatcher.registerHandler(
				{ kind: "rpc", channel: "unknown.endpoint:v1" } as never,
				(() => ({})) as never,
			),
		).toThrow("unknown RPC endpoint: unknown.endpoint:v1");
	});

	it("rejects duplicate channel registration", () => {
		const dispatcher = new Dispatcher();
		dispatcher.registerHandler(RPC.settings.get, async () => ({ settings: {} }));

		expect(() =>
			dispatcher.registerHandler(RPC.settings.get, async () => ({ settings: {} })),
		).toThrow("duplicate RPC handler registration: settings.get:v1");
	});

	it("rejects unknown fields without leaking validation internals", async () => {
		const dispatcher = new Dispatcher();
		dispatcher.registerHandler(RPC.settings.get, async () => ({ settings: {} }));
		await expect(dispatcher.dispatch("settings.get:v1", { bypass: true })).resolves.toEqual({
			ok: false,
			error: { kind: "invalid_request", reason: "request_validation_failed" },
		});
	});

	it.each(["invalid_request", "not_found", "conflict", "unavailable", "internal"] as const)(
		"preserves valid handler-thrown kind %s",
		async (kind) => {
			const dispatcher = new Dispatcher();
			dispatcher.registerHandler(RPC.message.send, async () => {
				throw { kind, reason: "safe_reason" };
			});

			await expect(
				dispatcher.dispatch(RPC.message.send.channel, { conversationId: "c1", text: "hello" }),
			).resolves.toEqual({
				ok: false,
				error: { kind, reason: "safe_reason" },
			});
		},
	);

	it("normalizes an unknown handler-thrown kind to internal", async () => {
		const dispatcher = new Dispatcher();
		dispatcher.registerHandler(RPC.message.send, async () => {
			throw { kind: "not_a_protocol_kind", reason: "safe_reason" };
		});

		await expect(
			dispatcher.dispatch(RPC.message.send.channel, { conversationId: "c1", text: "hello" }),
		).resolves.toEqual({
			ok: false,
			error: { kind: "internal", reason: "safe_reason" },
		});
	});

	it("throws on malformed responses when throw mode is explicit", async () => {
		const violations: ProtocolResponseValidationError[] = [];
		const dispatcher = new Dispatcher({
			responseValidation: "throw",
			onProtocolViolation: (error) => violations.push(error),
		});
		dispatcher.registerHandler(RPC.memory.search, (async () => ({
			entries: [{ id: "missing-required-fields" }],
		})) as never);

		await expect(
			dispatcher.dispatch(RPC.memory.search.channel, { query: "test" }),
		).rejects.toBeInstanceOf(ProtocolResponseValidationError);
		expect(violations).toHaveLength(1);
	});

	it("isolates malformed responses in isolate mode", async () => {
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
