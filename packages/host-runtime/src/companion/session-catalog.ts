import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { ArtifactStore } from "../artifacts/index.js";
import type { AppDatabase } from "../storage/database.js";
import {
	activeConversations,
	artifactAdoptions,
	artifacts,
	canonSources,
	conversations,
	evidence,
	runManifests,
	runs,
} from "../storage/schema.js";
import type { CompanionStateStore, CompanionStateTransaction } from "./companion-store.js";
import type { PiRuntime } from "./pi-runtime.js";

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
	private selectionTail: Promise<void> = Promise.resolve();

	async list(companionId: string, query: SessionCatalogQuery = {}) {
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
		const allowed = new Set(rows.map((row) => row.id));
		const words = query.title?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
		return (await this.pi.list())
			.filter((session) => allowed.has(session.id))
			.filter((session) => {
				const name = session.name?.toLocaleLowerCase() ?? "";
				return words.every((word) => name.includes(word));
			})
			.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}

	async createAndSelect(companionId: string, title = "") {
		return this.enqueueSelectionMutation(async () => {
			const previousConversationId = this.activeConversationId(companionId);
			let sessionId: string | undefined;
			let registered = false;
			try {
				return await this.pi.create(title, (id) => {
					sessionId = id;
					this.registerAndSelect(companionId, id);
					registered = true;
				});
			} catch (error) {
				if (registered && sessionId)
					this.rollbackRegistration(companionId, sessionId, previousConversationId);
				throw error;
			}
		});
	}

	async open(companionId: string, sessionId: string) {
		this.requireOwned(companionId, sessionId);
		return this.pi.open(sessionId);
	}

	async activeGet(companionId: string) {
		const sessionId = this.activeConversationId(companionId);
		return sessionId ? this.pi.open(sessionId) : undefined;
	}

	async select(companionId: string, sessionId: string) {
		return this.enqueueSelectionMutation(async () => {
			this.requireSelectable(companionId, sessionId);
			const session = await this.pi.open(sessionId);
			this.persistActive(companionId, sessionId);
			return session;
		});
	}

	async rename(companionId: string, sessionId: string, title: string) {
		this.requireOwned(companionId, sessionId);
		await this.pi.rename(sessionId, title);
	}

	async fork(companionId: string, sourceSessionId: string, entryId: string) {
		return this.enqueueSelectionMutation(async () => {
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
			const previousConversationId = this.activeConversationId(companionId);
			let sessionId: string | undefined;
			let registered = false;
			try {
				return await this.pi.fork(sourceSessionId, entryId, forkTitle, (id) => {
					sessionId = id;
					this.registerAndSelect(companionId, id, (tx) =>
						this.state.cloneConversationState(tx, companionId, sourceSessionId, id),
					);
					registered = true;
				});
			} catch (error) {
				if (registered && sessionId)
					this.rollbackRegistration(companionId, sessionId, previousConversationId);
				throw error;
			}
		});
	}

	async archive(companionId: string, sessionId: string, archived: boolean): Promise<void> {
		return this.enqueueSelectionMutation(async () => {
			this.requireOwned(companionId, sessionId);
			if (archived) await this.pi.close(sessionId, "preserve");
			this.db.transaction((tx) => {
				tx.update(conversations)
					.set({ archivedAt: archived ? new Date().toISOString() : null })
					.where(eq(conversations.id, sessionId))
					.run();
				if (archived) {
					tx.delete(activeConversations)
						.where(
							and(
								eq(activeConversations.companionId, companionId),
								eq(activeConversations.conversationId, sessionId),
							),
						)
						.run();
				}
			});
		});
	}

	async delete(companionId: string, sessionId: string): Promise<void> {
		return this.enqueueSelectionMutation(async () => {
			const owner = this.ownerOf(sessionId);
			if (!owner) return;
			if (owner !== companionId) throw { kind: "not_found", reason: "conversation_not_found" };
			await this.pi.delete(sessionId, async () => {
				const session = (await this.pi.list()).find((candidate) => candidate.id === sessionId);
				await this.options.beforeDelete?.(sessionId);
				if (session?.path) await deleteSessionFile(session.path);
				const hashes = this.deleteOwnedData(companionId, sessionId);
				this.options.artifacts?.purgeUnreferenced(hashes);
			});
		});
	}

	private deleteOwnedData(companionId: string, sessionId: string): string[] {
		return this.db.transaction((tx) => {
			tx.delete(activeConversations)
				.where(
					and(
						eq(activeConversations.companionId, companionId),
						eq(activeConversations.conversationId, sessionId),
					),
				)
				.run();
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

	private enqueueSelectionMutation<T>(mutation: () => Promise<T>): Promise<T> {
		const result = this.selectionTail.then(mutation, mutation);
		this.selectionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private registerAndSelect(
		companionId: string,
		sessionId: string,
		initialize?: (tx: CompanionStateTransaction) => void,
	): void {
		this.db.transaction((tx) => {
			tx.insert(conversations).values({ id: sessionId, companionId }).run();
			initialize?.(tx);
			tx.insert(activeConversations)
				.values({
					companionId,
					conversationId: sessionId,
					updatedAt: new Date().toISOString(),
				})
				.onConflictDoUpdate({
					target: activeConversations.companionId,
					set: {
						conversationId: sessionId,
						updatedAt: new Date().toISOString(),
					},
				})
				.run();
		});
	}

	private rollbackRegistration(
		companionId: string,
		sessionId: string,
		previousConversationId: string | undefined,
	): void {
		this.db.transaction((tx) => {
			const cleared = tx
				.delete(activeConversations)
				.where(
					and(
						eq(activeConversations.companionId, companionId),
						eq(activeConversations.conversationId, sessionId),
					),
				)
				.run();
			tx.delete(conversations).where(eq(conversations.id, sessionId)).run();
			if (cleared.changes && previousConversationId) {
				tx.insert(activeConversations)
					.values({
						companionId,
						conversationId: previousConversationId,
						updatedAt: new Date().toISOString(),
					})
					.run();
			}
		});
	}

	private persistActive(companionId: string, sessionId: string): void {
		const updatedAt = new Date().toISOString();
		this.db
			.insert(activeConversations)
			.values({ companionId, conversationId: sessionId, updatedAt })
			.onConflictDoUpdate({
				target: activeConversations.companionId,
				set: { conversationId: sessionId, updatedAt },
			})
			.run();
	}

	private activeConversationId(companionId: string): string | undefined {
		return this.db
			.select({ conversationId: activeConversations.conversationId })
			.from(activeConversations)
			.where(eq(activeConversations.companionId, companionId))
			.get()?.conversationId;
	}

	private requireSelectable(companionId: string, sessionId: string): void {
		const conversation = this.db
			.select({ archivedAt: conversations.archivedAt })
			.from(conversations)
			.where(and(eq(conversations.id, sessionId), eq(conversations.companionId, companionId)))
			.get();
		if (!conversation) throw { kind: "not_found", reason: "conversation_not_found" };
		if (conversation.archivedAt) throw { kind: "conflict", reason: "conversation_archived" };
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
