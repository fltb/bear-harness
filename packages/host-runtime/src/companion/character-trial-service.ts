import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CharacterTrialRequest, LivePush } from "@bear-harness/protocol";
import { ArtifactStore } from "../artifacts/index.js";
import { type CanonEmbeddingService, CanonHubService } from "../canon/service.js";
import type { ProviderCatalog } from "../providers/catalog.js";
import { COMPANION_SCHEMA_SQL, CompanionDatabase } from "../storage/database.js";
import { InvalidationHub } from "../storage/invalidation-hub.js";
import type { CharacterDraftService } from "./character-draft-service.js";
import { CharacterLoader } from "./character-loader.js";
import { CompanionStateStore } from "./companion-store.js";
import { ContextPackCompiler } from "./context-pack.js";
import { projectPiConversationDetail } from "./pi-live-events.js";
import { PiRuntime } from "./pi-runtime.js";
import { SessionCatalog } from "./session-catalog.js";

type Trial = {
	draftId: string;
	characterId: string;
	root: string;
	pi: PiRuntime;
	database: CompanionDatabase;
	canon: CanonHubService;
	sessionId: string;
};
/** Real Pi handles with their own package snapshot, database, Canon index and transcript. */
export class CharacterTrialService {
	private readonly handles = new Map<string, Trial>();
	private readonly opening = new Set<Promise<unknown>>();
	private closed = false;
	private readonly deletingDrafts = new Set<string>();
	private readonly deletingCharacters = new Set<string>();
	private readonly disposing = new Map<string, Promise<void>>();
	constructor(
		private readonly drafts: CharacterDraftService,
		private readonly providers: ProviderCatalog,
		private readonly embedding: () => Promise<CanonEmbeddingService | undefined>,
		private readonly emit: (event: LivePush) => void,
	) {}
	async request(input: CharacterTrialRequest) {
		if (this.closed) throw { kind: "unavailable", reason: "studio_trial_closed" };
		if (input.action === "start") {
			const operation = this.start(input);
			this.opening.add(operation);
			try {
				return await operation;
			} finally {
				this.opening.delete(operation);
			}
		}
		const trial = this.handles.get(input.trialId);
		if (!trial) {
			if (input.action === "close") return { trialId: input.trialId };
			throw { kind: "not_found", reason: "studio_trial_not_found" };
		}
		if (input.action === "close") {
			await this.dispose(input.trialId, trial);
			return { trialId: input.trialId };
		}
		if (input.action === "send")
			await trial.pi.send(trial.sessionId, input.text, undefined, input.clientMessageId);
		if (input.action === "abort") await trial.pi.abort(trial.sessionId);
		const session = trial.pi.snapshot(trial.sessionId);
		if (!session) throw { kind: "not_found", reason: "studio_trial_not_found" };
		return { trialId: input.trialId, detail: projectPiConversationDetail(session, 1000) };
	}
	private async start(input: Extract<CharacterTrialRequest, { action: "start" }>) {
		if (this.handles.size + this.opening.size >= 8)
			throw { kind: "unavailable", reason: "studio_trial_limit" };
		const source = this.drafts.trialSource(input.id, input.expectedRevision);
		if (this.deletingDrafts.has(input.id) || this.deletingCharacters.has(source.draft.characterId))
			throw { kind: "unavailable", reason: "studio_trial_closed" };
		const trialId = randomUUID();
		const root = join(source.root, "trials", trialId);
		const parent = join(source.root, "trials");
		if (
			existsSync(parent) &&
			(lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory())
		)
			throw { kind: "invalid_request", reason: "character_draft_path_invalid" };
		mkdirSync(join(root, "sessions"), { recursive: true, mode: 0o700 });
		let database: CompanionDatabase | undefined;
		let pi: PiRuntime | undefined;
		let canon: CanonHubService | undefined;
		try {
			const loader = new CharacterLoader(join(root, "source"), join(root, "package"));
			const character = loader.install(source.files);
			database = new CompanionDatabase(join(root, "runtime.db"), character.id);
			database.initialize(COMPANION_SCHEMA_SQL);
			database.ensureRuntimeIdentity();
			const store = new CompanionStateStore(database.orm);
			store.reconcileSchema(character.id, character.state);
			canon = new CanonHubService(
				database.orm,
				new ArtifactStore(database.orm, join(root, "artifacts")),
				new InvalidationHub({ scope: "character", characterId: character.id }),
				this.embedding,
				database,
			);
			canon.syncPackage(character.id, character.canon);
			const context = new ContextPackCompiler(database.orm, loader, canon, store);
			const disabled = async (): Promise<never> => {
				throw new Error("This tool is unavailable in Studio trial.");
			};
			const trialCanon = canon;
			pi = new PiRuntime({
				paths: { runtime: root, sessions: join(root, "sessions") },
				models: this.providers,
				character: () => character,
				store,
				toolAllowlist: ["role_skill", "host_state", "host_media", "host_choices", "host_canon"],
				runners: () => [],
				delegate: disabled,
				runRead: disabled,
				runControl: disabled,
				canon: async (_id, query, limit) =>
					trialCanon.retrieveHybrid(character.id, query, { limit, includeAdjacent: false }),
				memory: {
					enabled: () => false,
					recall: async () => ({}),
					capture: async () => {},
					drain: async () => {},
					search: disabled,
					searchConversations: disabled,
					explicit: { read: async () => "", edit: disabled },
				},
				defaultModel: () => ({ providerId: input.providerId, modelId: input.modelId }),
				multimodalFallback: () => undefined,
				context: async (sessionId, text) =>
					context.render(await context.compileForTurn(sessionId, { canonQuery: text })),
				sessionEvent: (_id, event) => this.emit({ type: "studioTrial", trialId, event }),
			});
			pi.configure({ ...loader.piResources(character), pluginPaths: [] });
			const session = await new SessionCatalog(database.orm, pi, store).create(
				character.id,
				"Studio",
			);
			if (
				this.closed ||
				this.deletingDrafts.has(input.id) ||
				this.deletingCharacters.has(character.id)
			)
				throw new Error("Studio closed while opening trial");
			this.handles.set(trialId, {
				draftId: input.id,
				characterId: character.id,
				root,
				pi,
				database,
				canon,
				sessionId: session.sessionId,
			});
			return { trialId, detail: projectPiConversationDetail(session, 1000) };
		} catch (error) {
			await pi?.closeAll();
			await canon?.close();
			database?.close();
			rmSync(root, { recursive: true, force: true });
			throw error;
		}
	}
	async closeDraft(draftId: string) {
		this.deletingDrafts.add(draftId);
		await Promise.allSettled(this.opening);
		for (const [id, trial] of this.handles)
			if (trial.draftId === draftId) await this.dispose(id, trial);
	}
	async closeCharacter(characterId: string) {
		this.deletingCharacters.add(characterId);
		await Promise.allSettled(this.opening);
		for (const [id, trial] of this.handles)
			if (trial.characterId === characterId) await this.dispose(id, trial);
	}
	allowDraft(draftId: string) {
		this.deletingDrafts.delete(draftId);
	}
	allowCharacter(characterId: string) {
		this.deletingCharacters.delete(characterId);
	}
	async close() {
		this.closed = true;
		await Promise.allSettled(this.opening);
		for (const [id, trial] of this.handles) await this.dispose(id, trial);
	}
	private dispose(id: string, trial: Trial): Promise<void> {
		const existing = this.disposing.get(id);
		if (existing) return existing;
		const pending = this.disposeResource(id, trial).finally(() => this.disposing.delete(id));
		this.disposing.set(id, pending);
		return pending;
	}
	private async disposeResource(id: string, trial: Trial) {
		await trial.pi.closeAll();
		await trial.canon.close();
		trial.database.close();
		this.handles.delete(id);
		rmSync(trial.root, { recursive: true, force: true });
	}
}
