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
import { ArtifactStore } from "./artifacts/index.js";
import { CommissionService } from "./commissions/service.js";
import { CharacterBehaviorService } from "./companion/character-behavior.js";
import { CharacterLoader } from "./companion/character-loader.js";
import { FirstMeetingMachine } from "./companion/first-meeting.js";
import { CompanionSupervisor } from "./companion/supervisor.js";
import { TurnPipeline } from "./companion/turn-pipeline.js";
import { VoiceStackManager } from "./companion/voice-stack.js";
import { type HostCompositionContext, wireHostHandlers } from "./composition.js";
import { Dispatcher, type RpcResponse } from "./dispatcher.js";
import { CodexAdapter } from "./executors/codex-adapter.js";
import { PiAcpAdapter, seedPiAcpProfile } from "./executors/pi-adapter.js";
import { ExecutorRouter } from "./executors/router.js";
import { MemoryService } from "./memory/service.js";
import { ProviderCatalog } from "./providers/catalog.js";
import { CredentialStore, type CredentialVault } from "./providers/credential-store.js";
import { Database, MIGRATIONS } from "./storage/database.js";
import { EventBus } from "./storage/event-bus.js";

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
}

export class HostRuntime {
	/** RPC dispatcher: validates against the shared protocol schemas. */
	readonly dispatcher: Dispatcher;

	private readonly db: Database;
	private readonly providers: ProviderCatalog;
	private readonly supervisor: CompanionSupervisor;
	private readonly characterBehavior: CharacterBehaviorService;
	private readonly characterLoader: CharacterLoader;
	private readonly composition: HostCompositionContext;
	private started = false;
	private closed = false;

	constructor(options: HostRuntimeOptions) {
		const dataDir = options.dataDir;
		const characterRoot = process.env.BEAR_CONFIG_DIR ?? options.characterRoot;

		// Canonical storage: one connection, migrations applied at boot.
		const db = new Database(join(dataDir, "storage"));
		db.migrate(MIGRATIONS);
		const dbConnection = db.connection;

		const eventBus = new EventBus(dbConnection);
		const artifactStore = new ArtifactStore(dbConnection, join(dataDir, "artifacts"));
		const credentials = new CredentialStore(dbConnection, options.credentialVault);
		const providers = new ProviderCatalog(credentials, join(dataDir, "companion-runtime"));
		const characterLoader = new CharacterLoader(characterRoot);
		const supervisor = new CompanionSupervisor(dataDir, eventBus, providers);
		const characterBehavior = new CharacterBehaviorService(dbConnection, eventBus, characterLoader);
		supervisor.setHostToolHandler((call) => characterBehavior.invoke(call));
		const memory = new MemoryService(dbConnection, eventBus);
		const onboarding = new FirstMeetingMachine(dbConnection, eventBus, characterLoader);
		const turns = new TurnPipeline(dbConnection, supervisor, eventBus);
		const voice = new VoiceStackManager(dbConnection, eventBus);
		seedPiAcpProfile(dbConnection);
		const executorRouter = new ExecutorRouter(dbConnection);
		executorRouter.register("product-managed", new PiAcpAdapter(dbConnection, dataDir));
		executorRouter.register("codex", new CodexAdapter(dbConnection, eventBus));
		const commissions = new CommissionService(
			dbConnection,
			eventBus,
			artifactStore,
			executorRouter,
		);

		this.db = db;
		this.providers = providers;
		this.supervisor = supervisor;
		this.characterBehavior = characterBehavior;
		this.characterLoader = characterLoader;
		this.composition = {
			db: dbConnection,
			eventBus,
			onboarding,
			turns,
			voice,
			memory,
			commissions,
			providers,
			characterLoader,
			defaultCharacterId: options.productConfig.defaultCharacterId,
		};
		this.dispatcher = new Dispatcher();
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
			this.composition.db,
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
		this.characterBehavior.dispose();
		this.providers.dispose();
		this.db.close();
	}
}

/** Create an instance-scoped companion host runtime. */
export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
	return new HostRuntime(options);
}
