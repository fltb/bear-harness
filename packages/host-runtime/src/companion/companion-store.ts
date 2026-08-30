import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import {
	companionStateDocuments,
	pendingStateMutations,
	stateMutationLog,
} from "../storage/schema.js";
import type { CharacterPackage } from "./character-loader.js";

type AppTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
export type CompanionDomain = "display" | "collection";

export interface DisplayState {
	sceneId: string;
	expressionId: string;
	surfaces: {
		ambient: string | null;
		inline: string | null;
		modal: string | null;
		choices: string | null;
	};
}

export interface CollectionState {
	seenMediaIds: string[];
	unlocks: string[];
	factIds: string[];
}

export type CompanionMutation =
	| { domain: "display"; op: "set_scene"; sceneId: string }
	| { domain: "display"; op: "set_expression"; expressionId: string }
	| {
			domain: "display";
			op: "present";
			surface: "ambient" | "inline" | "modal" | "choices";
			resourceId: string;
	  }
	| {
			domain: "display";
			op: "dismiss";
			surface: "ambient" | "inline" | "modal" | "choices";
			resourceId?: string;
	  }
	| { domain: "collection"; op: "add_seen_media"; mediaId: string }
	| { domain: "collection"; op: "add_unlock"; unlockId: string }
	| { domain: "collection"; op: "add_fact"; factId: string };

export interface CompanionSnapshot {
	display: DisplayState;
	collection: CollectionState;
	revisions: { display: number; collection: number };
}

interface CommitInput {
	character: CharacterPackage;
	conversationId: string;
	commitId: string;
	authority: string;
	mutations: CompanionMutation[];
	piSessionId?: string;
	sourceUserEntryId?: string;
	assistantEntryId?: string;
	transaction?: AppTransaction;
}

/**
 * Canonical materialized state for Host-owned display and collection domains.
 * Events notify readers after a commit; they are never replayed to reconstruct
 * the current UI. CharacterStateService owns the sibling `character` domain.
 */
export class CompanionStore {
	constructor(private readonly db: AppDatabase) {}

	snapshot(character: CharacterPackage, conversationId: string): CompanionSnapshot {
		const displayRow = this.document(character.id, conversationId, "conversation", "display");
		const seenRow = this.document(character.id, conversationId, "conversation", "collection");
		const globalCollection = this.document(character.id, conversationId, "character", "collection");
		const display = normalizeDisplay(displayRow?.stateJson, character);
		const seen = normalizeCollection(seenRow?.stateJson);
		const global = normalizeCollection(globalCollection?.stateJson);
		return {
			display,
			collection: {
				seenMediaIds: unique(seen.seenMediaIds),
				unlocks: unique([...global.unlocks, ...seen.unlocks]),
				factIds: unique([...global.factIds, ...seen.factIds]),
			},
			revisions: {
				display: displayRow?.revision ?? 0,
				collection: Math.max(seenRow?.revision ?? 0, globalCollection?.revision ?? 0),
			},
		};
	}

	previewTurn(input: {
		character: CharacterPackage;
		conversationId: string;
		piSessionId: string;
		sourceUserEntryId: string;
	}): CompanionSnapshot {
		const current = this.snapshot(input.character, input.conversationId);
		const mutations = this.pendingForTurn(
			input.conversationId,
			input.piSessionId,
			input.sourceUserEntryId,
		);
		return reduceSnapshot(current, mutations, input.character);
	}

	stage(input: {
		character: CharacterPackage;
		conversationId: string;
		piSessionId: string;
		sourceUserEntryId: string;
		toolCallId: string;
		mutations: CompanionMutation[];
	}): CompanionSnapshot {
		const mutations = parseMutations(input.mutations);
		const current = this.previewTurn(input);
		const next = reduceSnapshot(current, mutations, input.character);
		this.db
			.insert(pendingStateMutations)
			.values({
				id: `companion:${input.piSessionId}:${input.sourceUserEntryId}:${input.toolCallId}`,
				companionId: input.character.id,
				conversationId: input.conversationId,
				piSessionId: input.piSessionId,
				sourceUserEntryId: input.sourceUserEntryId,
				operationsJson: mutations,
				expectedRevisionsJson: {},
				reason: "Companion display/collection effects.",
				schemaHash: "companion:v1",
			})
			.onConflictDoNothing()
			.run();
		return next;
	}

	commit(input: CommitInput): CompanionSnapshot {
		const existing = this.db
			.select({ id: stateMutationLog.id })
			.from(stateMutationLog)
			.where(eq(stateMutationLog.id, input.commitId))
			.get();
		if (existing) return this.snapshot(input.character, input.conversationId);
		const mutations = parseMutations(input.mutations);
		const persist = (transaction: AppTransaction) => {
			const before = this.snapshot(input.character, input.conversationId);
			const after = reduceSnapshot(before, mutations, input.character);
			this.persistChanged(transaction, input.character, input.conversationId, before, after);
			transaction
				.insert(stateMutationLog)
				.values({
					id: input.commitId,
					companionId: input.character.id,
					conversationId: input.conversationId,
					piSessionId: input.piSessionId ?? `host:${input.authority}`,
					sourceUserEntryId: input.sourceUserEntryId ?? input.commitId,
					assistantEntryId: input.assistantEntryId ?? input.commitId,
					operationsJson: mutations,
					beforeRevisionsJson: before.revisions,
					afterRevisionsJson: after.revisions,
					reason: `Companion ${input.authority} commit.`,
				})
				.onConflictDoNothing()
				.run();
		};
		if (input.transaction) persist(input.transaction);
		else this.db.transaction((transaction) => persist(transaction));
		return this.snapshot(input.character, input.conversationId);
	}

	commitTurn(input: {
		character: CharacterPackage;
		conversationId: string;
		piSessionId: string;
		sourceUserEntryId: string;
		assistantEntryId: string;
		transaction?: AppTransaction;
	}): { committed: boolean; snapshot: CompanionSnapshot } {
		const rows = this.pendingRows(input.conversationId, input.piSessionId, input.sourceUserEntryId);
		if (rows.length === 0)
			return { committed: false, snapshot: this.snapshot(input.character, input.conversationId) };
		const mutations = rows.flatMap((row) => parseMutations(row.operationsJson));
		const commitId = `turn:${input.piSessionId}:${input.sourceUserEntryId}`;
		const persist = (transaction: AppTransaction) => {
			this.commit({
				...input,
				commitId,
				authority: "model_turn",
				mutations,
				transaction,
			});
			for (const row of rows)
				transaction
					.update(pendingStateMutations)
					.set({
						status: "committed",
						assistantEntryId: input.assistantEntryId,
						committedAt: sql`datetime('now')`,
					})
					.where(eq(pendingStateMutations.id, row.id))
					.run();
		};
		if (input.transaction) persist(input.transaction);
		else this.db.transaction((transaction) => persist(transaction));
		return { committed: true, snapshot: this.snapshot(input.character, input.conversationId) };
	}

	discardTurn(conversationId: string, piSessionId: string, sourceUserEntryId: string): void {
		this.db
			.update(pendingStateMutations)
			.set({ status: "discarded" })
			.where(
				and(
					eq(pendingStateMutations.conversationId, conversationId),
					eq(pendingStateMutations.piSessionId, piSessionId),
					eq(pendingStateMutations.sourceUserEntryId, sourceUserEntryId),
					eq(pendingStateMutations.schemaHash, "companion:v1"),
					eq(pendingStateMutations.status, "pending"),
				),
			)
			.run();
	}

	markTurnFailed(input: {
		companionId: string;
		conversationId: string;
		piSessionId: string;
		sourceUserEntryId: string;
		toolCallId: string;
	}): void {
		this.db
			.insert(pendingStateMutations)
			.values({
				id: `failure:${input.piSessionId}:${input.sourceUserEntryId}:${input.toolCallId}`,
				companionId: input.companionId,
				conversationId: input.conversationId,
				piSessionId: input.piSessionId,
				sourceUserEntryId: input.sourceUserEntryId,
				operationsJson: [],
				expectedRevisionsJson: {},
				reason: "companion_turn_effect_failed",
				schemaHash: "companion:v1",
				status: "discarded",
			})
			.onConflictDoNothing()
			.run();
	}

	hasTurnFailure(conversationId: string, piSessionId: string, sourceUserEntryId: string): boolean {
		return Boolean(
			this.db
				.select({ id: pendingStateMutations.id })
				.from(pendingStateMutations)
				.where(
					and(
						eq(pendingStateMutations.conversationId, conversationId),
						eq(pendingStateMutations.piSessionId, piSessionId),
						eq(pendingStateMutations.sourceUserEntryId, sourceUserEntryId),
						eq(pendingStateMutations.reason, "companion_turn_effect_failed"),
					),
				)
				.get(),
		);
	}

	resetUnlocks(companionId: string): void {
		this.db
			.update(companionStateDocuments)
			.set({
				stateJson: sql`json_set(${companionStateDocuments.stateJson}, '$.unlocks', json('[]'))`,
				revision: sql`${companionStateDocuments.revision} + 1`,
				updatedAt: sql`datetime('now')`,
			})
			.where(
				and(
					eq(companionStateDocuments.companionId, companionId),
					eq(companionStateDocuments.domain, "collection"),
					eq(companionStateDocuments.scope, "character"),
				),
			)
			.run();
	}

	forkConversation(input: {
		character: CharacterPackage;
		sourceConversationId: string;
		targetConversationId: string;
		sourceEntryIds: Set<string>;
	}): void {
		const commits = this.db
			.select()
			.from(stateMutationLog)
			.where(eq(stateMutationLog.conversationId, input.sourceConversationId))
			.orderBy(asc(stateMutationLog.createdAt), asc(stateMutationLog.id))
			.all()
			.filter(
				(commit) =>
					isCompanionMutations(commit.operationsJson) &&
					commit.sourceUserEntryId !== null &&
					input.sourceEntryIds.has(commit.sourceUserEntryId),
			);
		for (const commit of commits)
			this.commit({
				character: input.character,
				conversationId: input.targetConversationId,
				commitId: `fork:${input.targetConversationId}:${commit.id}`,
				authority: "conversation_fork",
				mutations: parseMutations(commit.operationsJson),
			});
	}

	private persistChanged(
		transaction: AppTransaction,
		character: CharacterPackage,
		conversationId: string,
		before: CompanionSnapshot,
		after: CompanionSnapshot,
	): void {
		if (JSON.stringify(before.display) !== JSON.stringify(after.display))
			this.persistDocument(
				transaction,
				character.id,
				conversationId,
				"conversation",
				"display",
				{ ...after.display },
				"display:v1",
			);
		if (
			JSON.stringify(before.collection.seenMediaIds) !==
			JSON.stringify(after.collection.seenMediaIds)
		)
			this.persistDocument(
				transaction,
				character.id,
				conversationId,
				"conversation",
				"collection",
				{
					seenMediaIds: after.collection.seenMediaIds,
					unlocks: [],
					factIds: [],
				},
				"collection:v1",
			);
		if (
			JSON.stringify(before.collection.unlocks) !== JSON.stringify(after.collection.unlocks) ||
			JSON.stringify(before.collection.factIds) !== JSON.stringify(after.collection.factIds)
		)
			this.persistDocument(
				transaction,
				character.id,
				conversationId,
				"character",
				"collection",
				{
					seenMediaIds: [],
					unlocks: after.collection.unlocks,
					factIds: after.collection.factIds,
				},
				"collection:v1",
			);
	}

	private persistDocument(
		transaction: AppTransaction,
		companionId: string,
		conversationId: string,
		scope: "conversation" | "character",
		domain: CompanionDomain,
		stateJson: Record<string, unknown>,
		schemaHash: string,
	): void {
		const current = this.document(companionId, conversationId, scope, domain);
		transaction
			.insert(companionStateDocuments)
			.values({
				id: documentId(companionId, conversationId, scope, domain),
				companionId,
				...(scope === "conversation" ? { conversationId } : {}),
				scope,
				domain,
				stateJson,
				revision: (current?.revision ?? 0) + 1,
				schemaHash,
			})
			.onConflictDoUpdate({
				target: companionStateDocuments.id,
				set: {
					stateJson,
					revision: (current?.revision ?? 0) + 1,
					schemaHash,
					updatedAt: sql`datetime('now')`,
				},
			})
			.run();
	}

	private document(
		companionId: string,
		conversationId: string,
		scope: "conversation" | "character",
		domain: CompanionDomain,
	) {
		return this.db
			.select()
			.from(companionStateDocuments)
			.where(
				and(
					eq(companionStateDocuments.companionId, companionId),
					eq(companionStateDocuments.scope, scope),
					eq(companionStateDocuments.domain, domain),
					scope === "conversation"
						? eq(companionStateDocuments.conversationId, conversationId)
						: isNull(companionStateDocuments.conversationId),
				),
			)
			.get();
	}

	private pendingRows(conversationId: string, piSessionId: string, sourceUserEntryId: string) {
		return this.db
			.select()
			.from(pendingStateMutations)
			.where(
				and(
					eq(pendingStateMutations.conversationId, conversationId),
					eq(pendingStateMutations.piSessionId, piSessionId),
					eq(pendingStateMutations.sourceUserEntryId, sourceUserEntryId),
					eq(pendingStateMutations.schemaHash, "companion:v1"),
					eq(pendingStateMutations.status, "pending"),
				),
			)
			.orderBy(asc(pendingStateMutations.createdAt), asc(pendingStateMutations.id))
			.all();
	}

	private pendingForTurn(
		conversationId: string,
		piSessionId: string,
		sourceUserEntryId: string,
	): CompanionMutation[] {
		return this.pendingRows(conversationId, piSessionId, sourceUserEntryId).flatMap((row) =>
			parseMutations(row.operationsJson),
		);
	}
}

function isCompanionMutations(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(entry) => isRecord(entry) && (entry.domain === "display" || entry.domain === "collection"),
		)
	);
}

function normalizeDisplay(value: unknown, character: CharacterPackage): DisplayState {
	const record = isRecord(value) ? value : {};
	const surfaces = isRecord(record.surfaces) ? record.surfaces : {};
	const sceneId =
		typeof record.sceneId === "string" &&
		character.scenes.some((scene) => scene.id === record.sceneId)
			? record.sceneId
			: character.visual.default_scene;
	const expressionId =
		typeof record.expressionId === "string" &&
		character.visual.expressions.some((expression) => expression.id === record.expressionId)
			? record.expressionId
			: character.visual.default_expression;
	return {
		sceneId,
		expressionId,
		surfaces: {
			ambient: stringOrNull(surfaces.ambient),
			inline: stringOrNull(surfaces.inline),
			modal: stringOrNull(surfaces.modal),
			choices: stringOrNull(surfaces.choices),
		},
	};
}

function normalizeCollection(value: unknown): CollectionState {
	const record = isRecord(value) ? value : {};
	return {
		seenMediaIds: stringArray(record.seenMediaIds),
		unlocks: stringArray(record.unlocks),
		factIds: stringArray(record.factIds),
	};
}

function reduceSnapshot(
	base: CompanionSnapshot,
	mutations: CompanionMutation[],
	character: CharacterPackage,
): CompanionSnapshot {
	const next = structuredClone(base);
	for (const mutation of mutations) {
		if (mutation.domain === "display") {
			if (mutation.op === "set_scene") {
				if (!character.scenes.some((scene) => scene.id === mutation.sceneId))
					throw { kind: "validation_failed", reason: "display_scene_not_declared" };
				next.display.sceneId = mutation.sceneId;
			} else if (mutation.op === "set_expression") {
				if (!character.visual.expressions.some((item) => item.id === mutation.expressionId))
					throw { kind: "validation_failed", reason: "display_expression_not_declared" };
				next.display.expressionId = mutation.expressionId;
			} else if (mutation.op === "present") {
				if (mutation.surface === "choices") {
					if (!character.roleplay.choice_sets.some((item) => item.id === mutation.resourceId))
						throw { kind: "validation_failed", reason: "display_choices_not_declared" };
				} else if (!character.roleplay.media.some((item) => item.id === mutation.resourceId))
					throw { kind: "validation_failed", reason: "display_media_not_declared" };
				next.display.surfaces[mutation.surface] = mutation.resourceId;
			} else if (
				mutation.resourceId === undefined ||
				next.display.surfaces[mutation.surface] === mutation.resourceId
			) {
				next.display.surfaces[mutation.surface] = null;
			}
		} else if (mutation.op === "add_seen_media") {
			if (!character.roleplay.media.some((item) => item.id === mutation.mediaId))
				throw { kind: "validation_failed", reason: "collection_media_not_declared" };
			next.collection.seenMediaIds = unique([...next.collection.seenMediaIds, mutation.mediaId]);
		} else if (mutation.op === "add_unlock") {
			if (!character.roleplay.unlockables.some((item) => item.id === mutation.unlockId))
				throw { kind: "validation_failed", reason: "collection_unlock_not_declared" };
			next.collection.unlocks = unique([...next.collection.unlocks, mutation.unlockId]);
		} else {
			next.collection.factIds = unique([...next.collection.factIds, mutation.factId]);
		}
	}
	return next;
}

function parseMutations(value: unknown): CompanionMutation[] {
	if (!Array.isArray(value) || value.length > 50)
		throw { kind: "validation_failed", reason: "companion_mutations_invalid" };
	return value.map((mutation) => {
		if (!isRecord(mutation) || (mutation.domain !== "display" && mutation.domain !== "collection"))
			throw { kind: "validation_failed", reason: "companion_mutations_invalid" };
		if (mutation.domain === "display") {
			if (mutation.op === "set_scene" && validId(mutation.sceneId))
				return { domain: "display", op: "set_scene", sceneId: mutation.sceneId };
			if (mutation.op === "set_expression" && validId(mutation.expressionId))
				return { domain: "display", op: "set_expression", expressionId: mutation.expressionId };
			if (
				mutation.op === "present" &&
				validSurface(mutation.surface) &&
				validId(mutation.resourceId)
			)
				return {
					domain: "display",
					op: "present",
					surface: mutation.surface,
					resourceId: mutation.resourceId,
				};
			if (
				mutation.op === "dismiss" &&
				validSurface(mutation.surface) &&
				(mutation.resourceId === undefined || validId(mutation.resourceId))
			)
				return {
					domain: "display",
					op: "dismiss",
					surface: mutation.surface,
					...(mutation.resourceId ? { resourceId: mutation.resourceId } : {}),
				};
		} else {
			if (mutation.op === "add_seen_media" && validId(mutation.mediaId))
				return { domain: "collection", op: "add_seen_media", mediaId: mutation.mediaId };
			if (mutation.op === "add_unlock" && validId(mutation.unlockId))
				return { domain: "collection", op: "add_unlock", unlockId: mutation.unlockId };
			if (mutation.op === "add_fact" && validId(mutation.factId))
				return { domain: "collection", op: "add_fact", factId: mutation.factId };
		}
		throw { kind: "validation_failed", reason: "companion_mutations_invalid" };
	});
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function validSurface(value: unknown): value is "ambient" | "inline" | "modal" | "choices" {
	return value === "ambient" || value === "inline" || value === "modal" || value === "choices";
}

function documentId(
	companionId: string,
	conversationId: string,
	scope: "conversation" | "character",
	domain: CompanionDomain,
): string {
	return scope === "conversation"
		? `${companionId}:${domain}:conversation:${conversationId}`
		: `${companionId}:${domain}:character`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}
function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? unique(value.filter((item): item is string => typeof item === "string" && item.length > 0))
		: [];
}
function unique(values: string[]): string[] {
	return [...new Set(values)];
}
