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
		private readonly options: SessionCatalogOptions = {},
	) {}

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

	async create(companionId: string, title = "") {
		let sessionId: string | undefined;
		try {
			return await this.pi.create(title, (id) => {
				sessionId = id;
				this.db.insert(conversations).values({ id, companionId }).run();
			});
		} catch (error) {
			if (sessionId) this.db.delete(conversations).where(eq(conversations.id, sessionId)).run();
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
		this.requireOwned(companionId, sourceSessionId);
		const session = await this.pi.fork(sourceSessionId, entryId);
		this.db.insert(conversations).values({ id: session.sessionId, companionId }).run();
		return session;
	}

	async archive(companionId: string, sessionId: string, archived: boolean) {
		this.requireOwned(companionId, sessionId);
		this.db
			.update(conversations)
			.set({ archivedAt: archived ? new Date().toISOString() : null })
			.where(eq(conversations.id, sessionId))
			.run();
		if (archived) await this.pi.close(sessionId);
		return this.pi.snapshot(sessionId);
	}

	async delete(companionId: string, sessionId: string) {
		const owner = this.ownerOf(sessionId);
		if (!owner) return;
		if (owner !== companionId) throw { kind: "not_found", reason: "conversation_not_found" };
		await this.pi.delete(sessionId, async () => {
			const session = (await this.pi.list()).find((candidate) => candidate.id === sessionId);
			await this.options.beforeDelete?.(sessionId);
			if (session?.path) await deleteSessionFile(session.path);
			this.options.artifacts?.purgeUnreferenced(this.deleteOwnedData(companionId, sessionId));
		});
		return this.pi.snapshot(sessionId);
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
