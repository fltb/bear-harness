/**
 * HostRuntime — the instance-scoped companion host.
 *
 * One instance owns the canonical database (connection, migrations and
 * schema backups), every domain service, the character loader (injected
 * character root, never source-tree-relative), the product config inputs,
 * the RPC dispatcher, and the start/close lifecycle. There are no
 * module-level singletons: nothing here is shared between instances.
 *
 * Wiring order mirrors the legacy desktop boot (`initHostServices`):
 *   constructor  — open DB, migrate, build services, wire all handlers,
 *                  seed the active character package;
 *   start()      — resolve the active character, configure the Companion
 *                  Pi runtime, start the supervisor;
 *   close()      — stop the supervisor, dispose services, close the DB.
 */

import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { ArtifactStore } from "./artifacts/index.js";
import { CanonHubService } from "./canon/service.js";
import { CommissionService } from "./commissions/service.js";
import { CharacterBehaviorService } from "./companion/character-behavior.js";
import { CharacterLoader } from "./companion/character-loader.js";
import { ContextPackCompiler } from "./companion/context-pack.js";
import { FirstMeetingMachine } from "./companion/first-meeting.js";
import { CompanionSupervisor } from "./companion/supervisor.js";
import { TurnPipeline } from "./companion/turn-pipeline.js";
import { type HostCompositionContext, wireHostHandlers } from "./composition.js";
import { Dispatcher, type RpcResponse } from "./dispatcher.js";
import { CodexAdapter } from "./executors/codex-adapter.js";
import { PiAcpAdapter, seedPiAcpProfile } from "./executors/pi-adapter.js";
import { ExecutorRouter } from "./executors/router.js";
import { MemoryAutomation } from "./memory/automation.js";
import { MemoryService } from "./memory/service.js";
import { ModelRegistry } from "./models/registry.js";
import { ProviderCatalog } from "./providers/catalog.js";
import { CredentialStore, type CredentialVault } from "./providers/credential-store.js";
import { Database, MIGRATIONS } from "./storage/database.js";
import { EventBus } from "./storage/event-bus.js";
import { conversations, messages } from "./storage/schema.js";
import { StoryService } from "./story/service.js";

/** The subset of the product configuration the host runtime consumes. */
export interface RuntimeProductConfig {
	/** ASCII kebab-case id of the default character package. */
	readonly defaultCharacterId: string;
}

export interface HostRuntimeOptions {
	/**
	 * Root directory for all runtime-owned state: the canonical database
	 * lives under `<dataDir>/storage`, artifacts under `<dataDir>/artifacts`,
	 * and the Companion/Pi runtime under `<dataDir>/companion-runtime`.
	 */
	dataDir: string;
	/**
	 * Character package root — a directory of `<characterId>/character.yaml`
	 * packages. Injected, never derived from the source tree. The
	 * `BEAR_CONFIG_DIR` environment override still wins when set (kept from
	 * the legacy loader).
	 */
	characterRoot: string;
	/** Product identity inputs (the fork-visible product config). */
	productConfig: RuntimeProductConfig;
	/** Platform encryption boundary for provider credentials. */
	credentialVault: CredentialVault;
	/** Development throws protocol bugs; packaged apps isolate them into a safe RPC error. */
	protocolViolationMode?: "throw" | "isolate";
}

export class HostRuntime {
	/** RPC dispatcher: validates against the shared protocol schemas. */
	readonly dispatcher: Dispatcher;

	private readonly db: Database;
	private readonly providers: ProviderCatalog;
	private readonly supervisor: CompanionSupervisor;
	private readonly characterBehavior: CharacterBehaviorService;
	private readonly characterLoader: CharacterLoader;
	private readonly memoryAutomation: MemoryAutomation;
	private readonly unsubscribeStoryAutomation: () => void;
	private readonly composition: HostCompositionContext;
	private started = false;
	private closed = false;

	constructor(options: HostRuntimeOptions) {
		const dataDir = options.dataDir;
		const characterRoot = process.env.BEAR_CONFIG_DIR ?? options.characterRoot;

		// Canonical storage: one connection, migrations applied at boot.
		const db = new Database(join(dataDir, "storage"));
		db.migrate(MIGRATIONS);
		db.assertSchemaContract();

		const eventBus = new EventBus(db.orm);
		const artifactStore = new ArtifactStore(db.orm, join(dataDir, "artifacts"));
		const credentials = new CredentialStore(db.orm, options.credentialVault);
		const providers = new ProviderCatalog(credentials, join(dataDir, "companion-runtime"));
		const characterLoader = new CharacterLoader(characterRoot, join(dataDir, "characters"));
		const supervisor = new CompanionSupervisor(dataDir, eventBus, providers);
		const characterBehavior = new CharacterBehaviorService(db.orm, eventBus, characterLoader);
		const memory = new MemoryService(db.orm, eventBus);
		const memoryAutomation = new MemoryAutomation(db.orm, eventBus, memory);
		const story = new StoryService(db.orm, eventBus);
		const canon = new CanonHubService(db.orm, artifactStore, eventBus);
		const contextPack = new ContextPackCompiler(db.orm, characterLoader);
		supervisor.setContextHandler((conversationId, includeHistory, message) =>
			contextPack.render(
				contextPack.compile(conversationId, {
					includeConversationHistory: includeHistory,
					canonQuery: message,
				}),
			),
		);
		const unsubscribeStoryAutomation = eventBus.subscribe((event) => {
			if (event.kind !== "message.user_sent" || !event.payload || typeof event.payload !== "object")
				return;
			const payload = event.payload as Record<string, unknown>;
			if (
				typeof payload.conversationId !== "string" ||
				typeof payload.messageId !== "string" ||
				typeof payload.text !== "string"
			)
				return;
			const context = db.orm
				.select({ companionId: conversations.companionId, branchId: messages.branchId })
				.from(conversations)
				.innerJoin(messages, eq(messages.conversationId, conversations.id))
				.where(
					and(eq(conversations.id, payload.conversationId), eq(messages.id, payload.messageId)),
				)
				.get();
			if (!context) return;
			const result = story.handleUserText({
				companionId: context.companionId,
				conversationId: payload.conversationId,
				branchId: context.branchId,
				text: payload.text,
			});
			if (result.action === "ambiguous") {
				story.propose({
					companionId: context.companionId,
					conversationId: payload.conversationId,
					branchId: context.branchId,
					text: payload.text,
				});
			}
		});
		const onboarding = new FirstMeetingMachine(db.orm, eventBus, characterLoader);
		const turns = new TurnPipeline(db.orm, supervisor, eventBus);
		const models = new ModelRegistry(db.orm, eventBus);
		onboarding.setConversationCreatedHandler((companionId, conversationId) => {
			models.applyDefaultToConversation(companionId, conversationId);
		});
		supervisor.setModelSelectionHandler((conversationId, requiresImages) =>
			models.resolve(conversationId, requiresImages),
		);
		seedPiAcpProfile(db.orm);
		const executorRouter = new ExecutorRouter(db.orm);
		executorRouter.register("product-managed", new PiAcpAdapter(db.orm, dataDir));
		executorRouter.register("codex", new CodexAdapter(db.orm, eventBus));
		const commissions = new CommissionService(db.orm, eventBus, artifactStore, executorRouter);
		supervisor.setHostToolHandler((call) => {
			if (call.tool !== "host_propose_work") return characterBehavior.invoke(call);
			const args = call.args as {
				title: string;
				description: string;
				reads: string[];
				writes: string[];
				networkAllowed: boolean;
				toolNames: string[];
			};
			const draft = commissions.draft({ conversationId: call.conversationId, ...args });
			return {
				ok: true,
				message: "Action proposal created and is waiting for user approval.",
				data: draft,
			};
		});

		this.db = db;
		this.providers = providers;
		this.supervisor = supervisor;
		this.characterBehavior = characterBehavior;
		this.characterLoader = characterLoader;
		this.memoryAutomation = memoryAutomation;
		this.unsubscribeStoryAutomation = unsubscribeStoryAutomation;
		this.composition = {
			orm: db.orm,
			eventBus,
			onboarding,
			turns,
			models,
			memory,
			commissions,
			artifacts: artifactStore,
			story,
			canon,
			supervisor,
			providers,
			characterLoader,
			defaultCharacterId: options.productConfig.defaultCharacterId,
		};
		this.dispatcher = new Dispatcher({
			responseValidation: options.protocolViolationMode ?? "throw",
			onProtocolViolation: (error) => {
				eventBus.publish("diagnostics.protocol_violation", {
					channel: error.channel,
					issues: error.issues.map((issue) => ({
						path: issue.path.join("."),
						message: issue.message,
					})),
				});
			},
		});
		wireHostHandlers(this.dispatcher, this.composition);
	}

	/** Dispatch a protocol channel; validates and returns the shared envelope. */
	dispatch(channel: string, params: unknown): Promise<RpcResponse> {
		return this.dispatcher.dispatch(channel, params);
	}

	/**
	 * Start the companion runtime: resolve the active character package,
	 * configure the Pi resources, and start the supervisor. Idempotent.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const activeCharacterId = this.characterLoader.getActiveCharacterId(
			this.composition.orm,
			this.composition.defaultCharacterId,
		);
		const activeCharacter = this.characterLoader.load(activeCharacterId);
		if (!activeCharacter) throw new Error(`character package missing: ${activeCharacterId}`);
		this.supervisor.configureRuntime(this.characterLoader.piResources(activeCharacter));
		await this.supervisor.start();
	}

	/** Stop the companion runtime, dispose services, and close the database. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.supervisor.stop();
		this.composition.turns.dispose();
		this.memoryAutomation.dispose();
		this.unsubscribeStoryAutomation();
		this.characterBehavior.dispose();
		this.providers.dispose();
		this.db.close();
	}
}

/** Create an instance-scoped companion host runtime. */
export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
	return new HostRuntime(options);
}
