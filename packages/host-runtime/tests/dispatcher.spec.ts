// @vitest-environment node

import { RPC } from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";
import { Dispatcher, ProtocolResponseValidationError } from "../src/dispatcher.js";

describe("Zod RPC dispatcher", () => {
	it("reports every known RPC outcome to the audit hook without request content", async () => {
		const outcomes: unknown[] = [];
		const dispatcher = new Dispatcher({ onDispatchResult: (result) => outcomes.push(result) });
		dispatcher.registerHandler(RPC.provider.logout, async () => ({}));
		await dispatcher.dispatch(RPC.provider.logout.channel, { providerId: "secret-provider" });
		await dispatcher.dispatch(RPC.provider.logout.channel, { unexpected: "secret-value" });
		expect(outcomes).toEqual([
			{
				channel: RPC.provider.logout.channel,
				operation: "mutation",
				outcome: "ok",
			},
			{
				channel: RPC.provider.logout.channel,
				operation: "mutation",
				outcome: "error",
				error: { kind: "invalid_request", reason: "request_validation_failed" },
			},
		]);
		expect(JSON.stringify(outcomes)).not.toContain("secret-provider");
		expect(JSON.stringify(outcomes)).not.toContain("secret-value");
	});
	it("rejects unknown endpoint registration before dispatch", () => {
		const dispatcher = new Dispatcher();

		expect(() =>
			dispatcher.registerHandler(
				{ kind: "rpc", channel: "unknown.endpoint" } as never,
				(() => ({})) as never,
			),
		).toThrow("unknown RPC endpoint: unknown.endpoint");
	});

	it("rejects duplicate channel registration", () => {
		const dispatcher = new Dispatcher();
		dispatcher.registerHandler(RPC.settings.get, async () => ({ settings: {} }));

		expect(() =>
			dispatcher.registerHandler(RPC.settings.get, async () => ({ settings: {} })),
		).toThrow("duplicate RPC handler registration: settings.get");
	});

	it("rejects unknown fields without leaking validation internals", async () => {
		const dispatcher = new Dispatcher();
		dispatcher.registerHandler(RPC.settings.get, async () => ({ settings: {} }));
		await expect(dispatcher.dispatch("settings.get", { bypass: true })).resolves.toEqual({
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
				dispatcher.dispatch(RPC.message.send.channel, { conversationId: "c1", text: "hello", clientMessageId: "00000000-0000-4000-8000-000000000001" }),
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
			dispatcher.dispatch(RPC.message.send.channel, { conversationId: "c1", text: "hello", clientMessageId: "00000000-0000-4000-8000-000000000001" }),
		).resolves.toEqual({
			ok: false,
			error: { kind: "internal", reason: "safe_reason" },
		});
	});

	it("throws on malformed responses", async () => {
		const violations: ProtocolResponseValidationError[] = [];
		const dispatcher = new Dispatcher({
			onProtocolViolation: (error) => violations.push(error),
		});
		dispatcher.registerHandler(RPC.conversation.list, (async () => ({
			conversations: [{ id: "missing-required-fields" }],
		})) as never);

		await expect(dispatcher.dispatch(RPC.conversation.list.channel, {})).rejects.toBeInstanceOf(
			ProtocolResponseValidationError,
		);
		expect(violations).toHaveLength(1);
	});

	it("does not expose ordinary Error messages", async () => {
		const dispatcher = new Dispatcher();
		dispatcher.registerHandler(RPC.message.send, async () => {
			throw new Error("/private/secret/database.sqlite failed");
		});
		await expect(
			dispatcher.dispatch(RPC.message.send.channel, { conversationId: "c1", text: "hello", clientMessageId: "00000000-0000-4000-8000-000000000001" }),
		).resolves.toEqual({
			ok: false,
			error: { kind: "internal", reason: "handler_failed" },
		});
	});
});
