import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { companionStateDocuments } from "../storage/schema.js";
import type { CharacterPackage } from "./character-loader.js";
import {
	applyCharacterStateOperations,
	type CharacterStateDefinition,
	type CharacterStateOperation,
	compileCharacterStateSchema,
	defaultStateDocument,
	type JsonObject,
	type StateScope,
} from "./state-schema.js";

type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
type Domain = "character" | "display";
type Revisions = Record<StateScope, number>;

export interface CharacterStateProjection {
	document: JsonObject;
	schema: CharacterStateDefinition;
	revisions: Revisions;
	schemaHash: string;
}
export interface DisplayState {
	sceneId: string;
	expressionId: string;
	surfaces: Record<"ambient" | "inline" | "modal" | "choices", string | null>;
}
export interface CompanionSnapshot {
	display: DisplayState;
	revisions: { display: number };
}
export type CompanionMutation =
	| { domain: "display"; op: "set_scene"; sceneId: string }
	| { domain: "display"; op: "set_expression"; expressionId: string }
	| {
			domain: "display";
			op: "present" | "dismiss";
			surface: keyof DisplayState["surfaces"];
			resourceId?: string;
	  };

/** Two product documents. No Pi session, turn, message, queue, or lifecycle state. */
export class CompanionStateStore {
	constructor(private readonly db: AppDatabase) {}

	project(
		companionId: string,
		conversationId: string,
		definition: CharacterStateDefinition,
	): CharacterStateProjection {
		const stored: Partial<Record<StateScope, JsonObject>> = {};
		const revisions: Revisions = { global: 0, conversation: 0 };
		const schemaHash = hash(definition);
		for (const scope of ["global", "conversation"] as const) {
			const row = this.row(companionId, conversationId, scope, "character");
			if (row?.schemaHash !== undefined && row.schemaHash !== schemaHash)
				throw { kind: "conflict", reason: "character_state_schema_changed" };
			if (row) stored[scope] = row.stateJson as JsonObject;
			revisions[scope] = row?.revision ?? 0;
		}
		const document = {
			...defaultStateDocument(definition),
			...(stored.global ?? {}),
			...(stored.conversation ?? {}),
		};
		validate(definition, document);
		return {
			document,
			schema: definition,
			revisions,
			schemaHash,
		};
	}

	writeCompanion(input: {
		companionId: string;
		conversationId: string;
		definition: CharacterStateDefinition;
		operations: CharacterStateOperation[];
		authority: "model" | "user" | `skill:${string}`;
		evidence?: boolean;
		expectedRevisions?: Partial<Revisions>;
		character?: CharacterPackage;
		displayMutations?: (state: JsonObject, display: DisplayState) => CompanionMutation[];
	}) {
		const before = this.project(input.companionId, input.conversationId, input.definition);
		if (
			(input.expectedRevisions?.global !== undefined &&
				input.expectedRevisions.global !== before.revisions.global) ||
			(input.expectedRevisions?.conversation !== undefined &&
				input.expectedRevisions.conversation !== before.revisions.conversation)
		)
			throw { kind: "conflict", reason: "character_state_revision_conflict" };
		const after = applyCharacterStateOperations({
			definition: input.definition,
			document: before.document,
			operations: input.operations,
			authority: input.authority,
			evidence: input.evidence === true,
		});
		const beforeDisplay = input.character
			? this.snapshot(input.character, input.conversationId)
			: undefined;
		const nextDisplay = beforeDisplay ? structuredClone(beforeDisplay.display) : undefined;
		if (input.character && beforeDisplay && nextDisplay)
			for (const mutation of input.displayMutations?.(after, beforeDisplay.display) ?? [])
				mutateDisplay(nextDisplay, mutation, input.character);
		this.db.transaction((tx) => {
			for (const scope of ["global", "conversation"] as const) {
				const next = partition(after, input.definition, scope);
				const previous = partition(before.document, input.definition, scope);
				if (!equal(next, previous))
					this.save(
						tx,
						input.companionId,
						input.conversationId,
						scope,
						"character",
						next,
						before.revisions[scope] + 1,
						before.schemaHash,
					);
			}
			if (
				input.character &&
				beforeDisplay &&
				nextDisplay &&
				!equal(beforeDisplay.display, nextDisplay)
			)
				this.save(
					tx,
					input.companionId,
					input.conversationId,
					"conversation",
					"display",
					nextDisplay as unknown as Record<string, unknown>,
					beforeDisplay.revisions.display + 1,
					"display:v1",
				);
		});
		return {
			character: this.project(input.companionId, input.conversationId, input.definition),
			display: input.character ? this.snapshot(input.character, input.conversationId) : undefined,
		};
	}

	snapshot(character: CharacterPackage, conversationId: string): CompanionSnapshot {
		const row = this.row(character.id, conversationId, "conversation", "display");
		return {
			display: display(row?.stateJson, character),
			revisions: { display: row?.revision ?? 0 },
		};
	}

	writeDisplay(
		character: CharacterPackage,
		conversationId: string,
		mutations: CompanionMutation[],
	) {
		const before = this.snapshot(character, conversationId);
		const next = structuredClone(before.display);
		for (const mutation of mutations) mutateDisplay(next, mutation, character);
		if (!equal(before.display, next))
			this.db.transaction((tx) =>
				this.save(
					tx,
					character.id,
					conversationId,
					"conversation",
					"display",
					next as unknown as Record<string, unknown>,
					before.revisions.display + 1,
					"display:v1",
				),
			);
		return this.snapshot(character, conversationId);
	}

	reconcileSchema(companionId: string, definition: CharacterStateDefinition) {
		const rows = this.db
			.select()
			.from(companionStateDocuments)
			.where(
				and(
					eq(companionStateDocuments.companionId, companionId),
					eq(companionStateDocuments.domain, "character"),
				),
			)
			.all();
		const changed = rows.filter((row) => row.schemaHash !== hash(definition));
		if (!changed.length) return { status: "unchanged" as const, documents: 0 };
		if (definition["x-incompatible-state"] !== "reset")
			throw { kind: "conflict", reason: "character_state_schema_changed" };
		this.db
			.delete(companionStateDocuments)
			.where(
				and(
					eq(companionStateDocuments.companionId, companionId),
					eq(companionStateDocuments.domain, "character"),
				),
			)
			.run();
		return { status: "reset" as const, documents: changed.length };
	}

	private row(companionId: string, conversationId: string, scope: StateScope, domain: Domain) {
		return this.db
			.select()
			.from(companionStateDocuments)
			.where(
				and(
					eq(companionStateDocuments.companionId, companionId),
					scope === "global"
						? isNull(companionStateDocuments.conversationId)
						: eq(companionStateDocuments.conversationId, conversationId),
					eq(companionStateDocuments.scope, scope),
					eq(companionStateDocuments.domain, domain),
				),
			)
			.get();
	}

	private save(
		tx: Tx,
		companionId: string,
		conversationId: string,
		scope: StateScope,
		domain: Domain,
		stateJson: Record<string, unknown>,
		revision: number,
		schemaHash: string,
	) {
		const id = `${companionId}:${domain}:${scope === "global" ? "global" : conversationId}`;
		tx.insert(companionStateDocuments)
			.values({
				id,
				companionId,
				conversationId: scope === "global" ? null : conversationId,
				scope,
				domain,
				stateJson,
				revision,
				schemaHash,
			})
			.onConflictDoUpdate({
				target: companionStateDocuments.id,
				set: {
					stateJson,
					revision,
					schemaHash,
					updatedAt: sql`datetime('now')`,
				},
			})
			.run();
	}
}

function display(value: unknown, character: CharacterPackage): DisplayState {
	const row = record(value) ? value : {};
	const surfaces = record(row.surfaces) ? row.surfaces : {};
	return {
		sceneId: declared(row.sceneId, character.scenes) ? row.sceneId : character.visual.default_scene,
		expressionId: declared(row.expressionId, character.visual.expressions)
			? row.expressionId
			: character.visual.default_expression,
		surfaces: {
			ambient: text(surfaces.ambient),
			inline: text(surfaces.inline),
			modal: text(surfaces.modal),
			choices: text(surfaces.choices),
		},
	};
}

function mutateDisplay(
	next: DisplayState,
	mutation: CompanionMutation,
	character: CharacterPackage,
) {
	if (mutation.op === "set_scene") {
		if (!declared(mutation.sceneId, character.scenes)) throw invalid("display_scene_not_declared");
		next.sceneId = mutation.sceneId;
	} else if (mutation.op === "set_expression") {
		if (!declared(mutation.expressionId, character.visual.expressions))
			throw invalid("display_expression_not_declared");
		next.expressionId = mutation.expressionId;
	} else if (mutation.op === "present") {
		if (!mutation.resourceId) throw invalid("display_resource_required");
		const allowed =
			mutation.surface === "choices"
				? character.roleplay.choice_sets.some((item) => item.id === mutation.resourceId)
				: character.roleplay.media.some((item) => item.id === mutation.resourceId);
		if (!allowed) throw invalid("display_resource_not_declared");
		next.surfaces[mutation.surface] = mutation.resourceId;
	} else if (!mutation.resourceId || next.surfaces[mutation.surface] === mutation.resourceId)
		next.surfaces[mutation.surface] = null;
}

function partition(document: JsonObject, definition: CharacterStateDefinition, scope: StateScope) {
	return Object.fromEntries(
		[...compileCharacterStateSchema(definition).partitions]
			.filter(([, partitionScope]) => partitionScope === scope)
			.map(([name]) => [name, structuredClone(document[name])]),
	) as JsonObject;
}
function validate(definition: CharacterStateDefinition, value: JsonObject) {
	if (!compileCharacterStateSchema(definition).validate(value))
		throw invalid("character_state_invalid");
}
function hash(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function declared(value: unknown, items: Array<{ id: string }>): value is string {
	return typeof value === "string" && items.some((item) => item.id === value);
}
function text(value: unknown) {
	return typeof value === "string" && value ? value : null;
}
function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function equal(left: unknown, right: unknown) {
	return JSON.stringify(left) === JSON.stringify(right);
}
function invalid(reason: string) {
	return { kind: "validation_failed", reason };
}
