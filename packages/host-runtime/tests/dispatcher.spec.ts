// @vitest-environment node

import { RPC } from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";
import { wireHostHandlers } from "../src/composition.js";
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
				dispatcher.dispatch(RPC.message.send.channel, {
					conversationId: "c1",
					text: "hello",
					clientMessageId: "00000000-0000-4000-8000-000000000001",
				}),
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
			dispatcher.dispatch(RPC.message.send.channel, {
				conversationId: "c1",
				text: "hello",
				clientMessageId: "00000000-0000-4000-8000-000000000001",
			}),
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
			dispatcher.dispatch(RPC.message.send.channel, {
				conversationId: "c1",
				text: "hello",
				clientMessageId: "00000000-0000-4000-8000-000000000001",
			}),
		).resolves.toEqual({
			ok: false,
			error: { kind: "internal", reason: "handler_failed" },
		});
	});

	it("pages oversized product lists through the validated Host response path", async () => {
		const characters = Array.from({ length: 205 }, (_, index) => ({
			id: `character-${String(index).padStart(3, "0")}`,
			name: `Character ${index}`,
			subtitle: "Test character",
			active: index === 0,
		}));
		const sources = Array.from({ length: 205 }, (_, index) => ({
			id: `source-${String(index).padStart(3, "0")}`,
			logicalName: `Source ${index}`,
			mime: "text/plain",
			sha256: "a".repeat(64),
			chunkCount: 1,
			createdAt: "2026-01-01T00:00:00.000Z",
			origin: "user" as const,
			language: null,
			sourceKind: null,
		}));
		const modules = Array.from({ length: 205 }, (_, index) => ({
			id: `module-${String(index).padStart(3, "0")}`,
			kind: "event" as const,
			title: `Module ${index}`,
			instructions: "Test module",
			sourceChunkIds: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			origin: "user" as const,
			triggers: [],
		}));
		const providers = Array.from({ length: 65 }, (_, index) => ({
			id: `provider-${String(index).padStart(3, "0")}`,
			name: `Provider ${index}`,
			source: "custom" as const,
			added: true,
			authMethods: [{ type: "api_key" as const, name: "API key" }],
			credentialStatus: "stored" as const,
			availableModels: [],
			unavailable: [],
		}));
		const models = Array.from({ length: 205 }, (_, index) => ({
			providerId: "provider-000",
			modelId: `model-${String(index).padStart(3, "0")}`,
			label: `Model ${index}`,
			supportsImages: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			enabled: true,
			readiness: "ready" as const,
		}));
		const dispatcher = new Dispatcher();
		wireHostHandlers(dispatcher, {
			defaultCharacterId: characters[0]?.id,
			systemOrm: {},
			characterLoader: {
				getActiveCharacterId: () => characters[0]?.id,
				load: () => ({ id: characters[0]?.id, state: {} }),
				list: (_db: unknown, _defaultId: string, request: { cursor?: string; limit: number }) => {
					const cursorIndex = request.cursor
						? characters.findIndex((character) => character.id === request.cursor)
						: -1;
					const page = characters.slice(cursorIndex + 1, cursorIndex + 1 + request.limit);
					const last = page.at(-1);
					return {
						characters: page,
						...(cursorIndex + 1 + page.length < characters.length && last
							? { nextCursor: last.id }
							: {}),
					};
				},
			},
			companionStore: { reconcileSchema: () => undefined },
			canon: { listSources: () => sources, listModules: () => modules },
			providers: {
				listProviders: async () => providers,
				modelProjectionFacts: () => ({}),
			},
			models: { list: () => models },
		} as never);

		const first = await dispatcher.dispatch(RPC.character.list.channel, { limit: 100 });
		const sourcePage = await dispatcher.dispatch(RPC.canon.listSources.channel, { limit: 100 });
		const modulePage = await dispatcher.dispatch(RPC.canon.listModules.channel, { limit: 100 });
		const providerPage = await dispatcher.dispatch(RPC.provider.list.channel, { limit: 30 });
		const modelPage = await dispatcher.dispatch(RPC.model.poolGet.channel, { limit: 100 });
		expect({
			characters: first.ok,
			sources: sourcePage.ok,
			modules: modulePage.ok,
			providers: providerPage.ok,
			models: modelPage.ok,
		}).toEqual({
			characters: true,
			sources: true,
			modules: true,
			providers: true,
			models: true,
		});
		expect(first).toMatchObject({
			ok: true,
			data: { characters: expect.any(Array), nextCursor: "character-099" },
		});
		if (!first.ok) throw new Error("first character page failed");
		expect(first.data.characters).toHaveLength(100);
		const second = await dispatcher.dispatch(RPC.character.list.channel, {
			cursor: first.data.nextCursor,
			limit: 100,
		});
		if (!second.ok) throw new Error("second character page failed");
		expect(second.data.characters).toHaveLength(100);
		expect(second.data.nextCursor).toBe("character-199");
		const third = await dispatcher.dispatch(RPC.character.list.channel, {
			cursor: second.data.nextCursor,
			limit: 100,
		});
		if (!third.ok) throw new Error("third character page failed");
		expect(third.data.characters).toHaveLength(5);
		expect(third.data.nextCursor).toBeUndefined();

		if (!sourcePage.ok) throw new Error("source page failed");
		expect(sourcePage.data.sources).toHaveLength(100);
		expect(sourcePage.data.nextCursor).toBe("source-099");
		if (!modulePage.ok) throw new Error("module page failed");
		expect(modulePage.data.modules).toHaveLength(100);
		expect(modulePage.data.nextCursor).toBe("module-099");
		if (!providerPage.ok) throw new Error("provider page failed");
		expect(providerPage.data.providers).toHaveLength(30);
		expect(providerPage.data.nextCursor).toBe("provider-029");
		if (!modelPage.ok) throw new Error("model page failed");
		expect(modelPage.data.models).toHaveLength(100);
		expect(modelPage.data.nextCursor).toEqual({
			providerId: "provider-000",
			modelId: "model-099",
		});
	});
});
