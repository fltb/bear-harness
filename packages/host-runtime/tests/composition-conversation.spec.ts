// @vitest-environment node

import { RPC } from "@bear-harness/protocol/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type HostCompositionContext, wireHostHandlers } from "../src/composition.js";
import { Dispatcher, type RpcHandler } from "../src/dispatcher.js";
import {
	activeCharacter,
	companionIdentity,
	conversations,
	events,
} from "../src/storage/schema.js";

const timestamp = "2026-08-31T00:00:00.000Z";

function piSnapshot(sessionId: string, name = sessionId) {
	const entries = [
		{
			type: "message" as const,
			id: `${sessionId}-user`,
			parentId: null,
			timestamp,
			message: { role: "user" as const, content: `hello ${sessionId}`, timestamp: 1 },
		},
	];
	return {
		sessionId,
		sessionName: name,
		sessionManager: {
			buildContextEntries: () => entries,
			getBranch: () => entries,
			getTree: () => [{ entry: entries[0], children: [] }],
			getChildren: () => [],
			getLeafId: () => `${sessionId}-user`,
		},
		isStreaming: false,
		state: {
			streamingMessage: undefined,
			errorMessage: undefined,
			pendingToolCalls: new Set<string>(),
		},
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
	};
}

function queryResult(table: unknown) {
	const row =
		table === events
			? undefined
			: table === companionIdentity
				? { id: "bear" }
				: table === activeCharacter
					? { characterId: "bear" }
					: table === conversations
						? { id: "owned" }
						: undefined;
	const chain = {
		where: () => chain,
		orderBy: () => chain,
		limit: () => chain,
		get: () => row,
		all: () => (row ? [row] : []),
	};
	return chain;
}

function context() {
	const snapshots = {
		alpha: piSnapshot("alpha", "Alpha"),
		beta: piSnapshot("beta", "Beta"),
	};
	const sessions = {
		list: vi.fn(async () => []),
		create: vi.fn(async () => snapshots.alpha),
		open: vi.fn(async (_companionId: string, id: "alpha" | "beta") => snapshots[id]),
		activeGet: vi.fn(async () => undefined),
		rename: vi.fn(async () => undefined),
		archive: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
		fork: vi.fn(async () => snapshots.beta),
	};
	const pi = {
		send: vi.fn(async () => undefined),
		abort: vi.fn(async () => undefined),
		correct: vi.fn(async () => undefined),
		navigate: vi.fn(async () => undefined),
		edit: vi.fn(async () => undefined),
		continue: vi.fn(async () => undefined),
		modelFor: vi.fn(async (id: string) => ({ providerId: "provider", modelId: `${id}-model` })),
		setModel: vi.fn(async (_id: string, providerId: string, modelId: string) => ({
			providerId,
			modelId,
		})),
		configure: vi.fn(),
		close: vi.fn(),
		closeAll: vi.fn(async () => undefined),
	};
	const project = vi.fn(() => ({
		document: { affinity: 2 },
		revisions: { conversation: 1, global: 2 },
	}));
	const companionSnapshot = vi.fn(() => ({
		display: {
			sceneId: "scene",
			expressionId: "expression",
		},
		revisions: { display: 3 },
	}));
	const character = { id: "bear", state: { type: "object" }, canon: {} };
	const invalidations = { invalidate: vi.fn() };
	const livePush = vi.fn();
	const characterPackagePresenter = { reveal: vi.fn(async () => undefined) };
	const value = {
		signal: new AbortController().signal,
		orm: { select: () => ({ from: (table: unknown) => queryResult(table) }) },
		invalidations,
		livePush,
		onboarding: {
			initialize: vi.fn(),
			getState: vi.fn(() => ({ status: "completed", stateData: { decisions: {} } })),
		},
		pi,
		sessions,
		characterLoader: {
			getActiveCharacterId: vi.fn(() => "bear"),
			load: vi.fn(() => character),
			display: vi.fn(() => ({ id: "bear" })),
			seed: vi.fn(),
			activate: vi.fn(),
			pluginTrust: vi.fn(() => ({ trusted: true })),
			piResources: vi.fn(() => ({ appendSystemPrompt: "prompt", pluginPaths: [] })),
			packageLocation: vi.fn((characterId: string) => `/safe/characters/${characterId}`),
		},
		characterPackagePresenter,
		companionStore: {
			reconcileSchema: vi.fn(),
			project,
			snapshot: companionSnapshot,
		},
		canon: { syncPackage: vi.fn() },
		defaultCharacterId: "bear",
		appSettings: { load: vi.fn(() => ({ modelDownloadSource: { type: "official" } })) },
		models: {},
		providers: {},
	} as unknown as HostCompositionContext;
	return {
		value,
		sessions,
		pi,
		invalidations,
		project,
		companionSnapshot,
		snapshots,
		characterPackagePresenter,
	};
}

function handler(dispatcher: Dispatcher, channel: string): RpcHandler {
	const handlers = Reflect.get(dispatcher, "handlers") as Map<string, RpcHandler>;
	const selected = handlers.get(channel);
	if (!selected) throw new Error(`missing handler: ${channel}`);
	return selected;
}

describe("Host conversation projection and routing", () => {
	let dispatcher: Dispatcher;
	let fixture: ReturnType<typeof context>;

	beforeEach(() => {
		dispatcher = new Dispatcher();
		fixture = context();
		wireHostHandlers(dispatcher, fixture.value);
	});

	it("opens and branches into security-safe ConversationDetail values", async () => {
		const opened = await handler(
			dispatcher,
			RPC.conversation.open.channel,
		)({
			conversationId: "alpha",
		});
		expect(opened).toMatchObject({
			conversationId: "alpha",
			name: "Alpha",
			branch: {
				activeLeafId: "alpha-user",
				entries: [{ type: "message", message: { role: "user" } }],
			},
			live: { isStreaming: false },
		});
		const branch = await handler(
			dispatcher,
			RPC.message.branch.channel,
		)({
			conversationId: "alpha",
			entryId: "alpha-user",
		});
		expect(branch).toMatchObject({ conversationId: "beta", name: "Beta" });
		expect(fixture.sessions.fork).toHaveBeenCalledWith("bear", "alpha", "alpha-user");
		expect(fixture.pi.close).not.toHaveBeenCalled();
	});

	it("reveals only the Host-resolved package location for a validated character id", async () => {
		await expect(
			handler(dispatcher, RPC.character.packageReveal.channel)({ characterId: "bear" }),
		).resolves.toEqual({ revealed: true });
		expect(fixture.value.characterLoader.packageLocation).toHaveBeenCalledWith("bear");
		expect(fixture.characterPackagePresenter.reveal).toHaveBeenCalledWith("/safe/characters/bear");
	});

	it("routes concurrent message and model operations only by explicit conversation id", async () => {
		await Promise.all([
			handler(
				dispatcher,
				RPC.message.send.channel,
			)({
				conversationId: "alpha",
				text: "one",
				clientMessageId: "00000000-0000-4000-8000-000000000001",
			}),
			handler(
				dispatcher,
				RPC.message.send.channel,
			)({
				conversationId: "beta",
				text: "two",
				clientMessageId: "00000000-0000-4000-8000-000000000002",
			}),
		]);
		await handler(dispatcher, RPC.message.abort.channel)({ conversationId: "alpha" });
		await handler(
			dispatcher,
			RPC.message.correct.channel,
		)({
			conversationId: "beta",
			entryId: "entry",
			feedback: "again",
		});
		await handler(
			dispatcher,
			RPC.message.switchVersion.channel,
		)({
			conversationId: "alpha",
			leafId: "leaf",
		});
		await handler(
			dispatcher,
			RPC.message.edit.channel,
		)({
			conversationId: "beta",
			entryId: "entry",
			text: "edited",
		});
		await handler(dispatcher, RPC.message.continue.channel)({ conversationId: "alpha" });
		await handler(dispatcher, RPC.model.routeGet.channel)({ conversationId: "beta" });
		await handler(
			dispatcher,
			RPC.model.routeSet.channel,
		)({
			conversationId: "alpha",
			selected: { providerId: "provider", modelId: "model" },
		});

		expect(fixture.pi.send.mock.calls).toEqual([
			["alpha", "one"],
			["beta", "two"],
		]);
		expect(fixture.pi.abort).toHaveBeenCalledWith("alpha");
		expect(fixture.pi.correct).toHaveBeenCalledWith("beta", "entry", "again");
		expect(fixture.pi.navigate).toHaveBeenCalledWith("alpha", "leaf");
		expect(fixture.pi.edit).toHaveBeenCalledWith("beta", "entry", "edited");
		expect(fixture.pi.continue).toHaveBeenCalledWith("alpha");
		expect(fixture.pi.modelFor).toHaveBeenCalledWith("beta");
		expect(fixture.pi.setModel).toHaveBeenCalledWith("alpha", "provider", "model");
		expect(fixture.sessions.open).toHaveBeenCalledWith("bear", "beta");
		expect(fixture.sessions.open).toHaveBeenCalledWith("bear", "alpha");
		expect(fixture.pi.close).not.toHaveBeenCalled();
	});

	it("deduplicates repeated client message ids before calling Pi", async () => {
		const request = {
			conversationId: "alpha",
			text: "only once",
			clientMessageId: "00000000-0000-4000-8000-000000000099",
		};
		await Promise.all([
			handler(dispatcher, RPC.message.send.channel)(request),
			handler(dispatcher, RPC.message.send.channel)(request),
		]);
		expect(fixture.pi.send).toHaveBeenCalledTimes(1);
		expect(fixture.pi.send).toHaveBeenCalledWith("alpha", "only once");
	});

	it("moves companion state to its targeted read and keeps boot snapshot O(1)", async () => {
		const state = await handler(
			dispatcher,
			RPC.companionState.get.channel,
		)({
			conversationId: "beta",
		});
		expect(state).toMatchObject({
			schema: { type: "object" },
			state: {
				character: { document: { affinity: 2 } },
				display: { sceneId: "scene" },
			},
		});
		expect(fixture.project).toHaveBeenCalledWith("bear", "beta", { type: "object" });
		expect(fixture.companionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ id: "bear" }),
			"beta",
		);

		fixture.project.mockClear();
		fixture.companionSnapshot.mockClear();
		const snapshot = await handler(dispatcher, RPC.snapshot.get.channel)({});
		expect(snapshot).toHaveProperty("onboarding");
		expect(snapshot).not.toHaveProperty("conversation");
		expect(snapshot).not.toHaveProperty("companion");
		expect(fixture.project).not.toHaveBeenCalled();
		expect(fixture.companionSnapshot).not.toHaveBeenCalled();
	});

	it("returns the authoritative active projection after archive and delete", async () => {
		expect(
			await handler(
				dispatcher,
				RPC.conversation.archive.channel,
			)({
				conversationId: "alpha",
				archived: true,
			}),
		).toEqual({ activeConversation: null });
		expect(
			await handler(dispatcher, RPC.conversation.delete.channel)({ conversationId: "beta" }),
		).toEqual({ activeConversation: null });
		expect(fixture.sessions.archive).toHaveBeenCalledWith("bear", "alpha", true);
		expect(fixture.sessions.delete).toHaveBeenCalledWith("bear", "beta");
		expect(fixture.pi.close).not.toHaveBeenCalled();
	});
});
