import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { ArtifactStore } from "../artifacts/index.js";
import type { AppDatabase } from "../storage/database.js";
import {
	artifactAdoptions,
	artifacts,
	canonSources,
	conversations,
	evidence,
	runManifests,
	runs,
} from "../storage/schema.js";
import type { CompanionStateStore, CompanionStateTransaction } from "./companion-store.js";
import type { PiRuntime, PiSessionListQuery } from "./pi-runtime.js";

export interface SessionCatalogQuery {
	archived?: boolean;
	title?: string;
}

export interface SessionCatalogOptions {
	beforeDelete?(sessionId: string): Promise<void>;
	artifacts?: ArtifactStore;
}

/** Total-session management. It never reads or reconstructs Pi messages. */
export class SessionCatalog {
	constructor(
		private readonly db: AppDatabase,
		private readonly pi: PiRuntime,
		private readonly state: CompanionStateStore,
		private readonly options: SessionCatalogOptions = {},
	) {}
	/** Catalog mutations serialize only for their own resource, never the window selection. */
	private readonly mutations = new Map<string, Promise<unknown>>();

	async list(companionId: string, query: SessionCatalogQuery = {}) {
		return (await this.listPage(companionId, { ...query, limit: Number.MAX_SAFE_INTEGER }))
			.sessions;
	}

	async listPage(
		companionId: string,
		query: SessionCatalogQuery & Pick<PiSessionListQuery, "cursor" | "limit"> = {},
	) {
		const rows = this.db
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(
					eq(conversations.companionId, companionId),
					query.archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
				),
			)
			.all();
		return this.pi.listPage({ ...query, allowedIds: new Set(rows.map(({ id }) => id)) });
	}

	async create(companionId: string, title = "") {
		let sessionId: string | undefined;
		try {
			return await this.pi.create(title, (id) => {
				this.register(companionId, id);
				sessionId = id;
			});
		} catch (error) {
			if (sessionId) this.rollbackRegistration(companionId, sessionId);
			throw error;
		}
	}

	async open(companionId: string, sessionId: string) {
		this.requireOwned(companionId, sessionId);
		return this.pi.open(sessionId);
	}

	async rename(companionId: string, sessionId: string, title: string) {
		this.requireOwned(companionId, sessionId);
		await this.pi.rename(sessionId, title);
	}

	async fork(companionId: string, sourceSessionId: string, entryId: string) {
		return this.mutate(sourceSessionId, async () => {
			this.requireOwned(companionId, sourceSessionId);
			const piSessions = await this.pi.list();
			const source = piSessions.find((session) => session.id === sourceSessionId);
			const sourceTitle = source?.name || source?.firstMessage || "";
			const titles = new Set(piSessions.map((session) => session.name));
			let suffix = 1;
			while (titles.has(`${sourceTitle}(${suffix})`)) {
				suffix += 1;
			}
			const forkTitle = `${sourceTitle}(${suffix})`;
			let sessionId: string | undefined;
			let registered = false;
			try {
				return await this.pi.fork(sourceSessionId, entryId, forkTitle, (id) => {
					sessionId = id;
					this.register(companionId, id, (tx) =>
						this.state.cloneConversationState(tx, companionId, sourceSessionId, id),
					);
					registered = true;
				});
			} catch (error) {
				if (registered && sessionId) this.rollbackRegistration(companionId, sessionId);
				throw error;
			}
		});
	}

	async archive(companionId: string, sessionId: string, archived: boolean): Promise<void> {
		return this.mutate(sessionId, async () => {
			this.requireOwned(companionId, sessionId);
			if (archived) await this.pi.close(sessionId, "preserve");
			this.db
				.update(conversations)
				.set({ archivedAt: archived ? new Date().toISOString() : null })
				.where(and(eq(conversations.id, sessionId), eq(conversations.companionId, companionId)))
				.run();
		});
	}

	async delete(companionId: string, sessionId: string): Promise<void> {
		return this.mutate(sessionId, async () => {
			const owner = this.ownerOf(sessionId);
			if (!owner) return;
			if (owner !== companionId) throw { kind: "not_found", reason: "conversation_not_found" };
			await this.pi.delete(sessionId, async (sessionPath) => {
				await this.options.beforeDelete?.(sessionId);
				const ownedRuns = this.db
					.select({ id: runs.id })
					.from(runs)
					.where(eq(runs.conversationId, sessionId))
					.all()
					.map(({ id }) => id);
				const remove = async () => {
					if (sessionPath) await deleteSessionFile(sessionPath);
					const hashes = this.deleteOwnedData(companionId, sessionId);
					this.options.artifacts?.purgeUnreferenced(hashes);
				};
				if (this.options.artifacts) await this.options.artifacts.withRunDeletion(ownedRuns, remove);
				else await remove();
			});
		});
	}

	private deleteOwnedData(companionId: string, sessionId: string): string[] {
		return this.db.transaction((tx) => {
			const ownedRuns = tx
				.select({ id: runs.id })
				.from(runs)
				.where(eq(runs.conversationId, sessionId));
			const ownedArtifacts = tx
				.select({ id: artifacts.id })
				.from(artifacts)
				.where(inArray(artifacts.producerRunId, ownedRuns));
			const hashes = tx
				.select({ sha256: artifacts.sha256 })
				.from(artifacts)
				.where(inArray(artifacts.id, ownedArtifacts))
				.all()
				.map(({ sha256 }) => sha256);
			tx.update(canonSources)
				.set({ artifactId: null })
				.where(inArray(canonSources.artifactId, ownedArtifacts))
				.run();
			tx.delete(artifactAdoptions)
				.where(
					or(
						inArray(artifactAdoptions.runId, ownedRuns),
						inArray(artifactAdoptions.artifactId, ownedArtifacts),
					),
				)
				.run();
			tx.delete(artifacts).where(inArray(artifacts.id, ownedArtifacts)).run();
			tx.delete(runManifests).where(inArray(runManifests.runId, ownedRuns)).run();
			tx.delete(evidence).where(inArray(evidence.runId, ownedRuns)).run();
			tx.delete(runs).where(inArray(runs.id, ownedRuns)).run();
			tx.delete(conversations)
				.where(and(eq(conversations.id, sessionId), eq(conversations.companionId, companionId)))
				.run();
			return hashes;
		});
	}

	private async mutate<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
		const previous = this.mutations.get(sessionId);
		const result = previous ? previous.then(mutation, mutation) : mutation();
		this.mutations.set(sessionId, result);
		try {
			return await result;
		} finally {
			if (this.mutations.get(sessionId) === result) this.mutations.delete(sessionId);
		}
	}

	private register(
		companionId: string,
		sessionId: string,
		initialize?: (tx: CompanionStateTransaction) => void,
	): void {
		this.db.transaction((tx) => {
			tx.insert(conversations).values({ id: sessionId, companionId }).run();
			initialize?.(tx);
		});
	}

	private rollbackRegistration(companionId: string, sessionId: string): void {
		this.db
			.delete(conversations)
			.where(and(eq(conversations.id, sessionId), eq(conversations.companionId, companionId)))
			.run();
	}

	private requireOwned(companionId: string, sessionId: string) {
		if (this.ownerOf(sessionId) !== companionId)
			throw { kind: "not_found", reason: "conversation_not_found" };
	}

	private ownerOf(sessionId: string): string | undefined {
		return this.db
			.select({ companionId: conversations.companionId })
			.from(conversations)
			.where(eq(conversations.id, sessionId))
			.get()?.companionId;
	}
}

/** Match Pi's user-facing deletion policy while keeping ownership in Bear. */
async function deleteSessionFile(sessionPath: string): Promise<void> {
	if (!existsSync(sessionPath)) return;
	const args = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashed = spawnSync("trash", args, { encoding: "utf8" });
	if (trashed.status === 0 || !existsSync(sessionPath)) return;
	try {
		await unlink(sessionPath);
	} catch (error) {
		if (!existsSync(sessionPath)) return;
		throw error;
	}
}
