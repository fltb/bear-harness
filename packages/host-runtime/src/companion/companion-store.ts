import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import jsonPatch from "fast-json-patch";
import type { AppDatabase } from "../storage/database.js";
import { companionStateDocuments } from "../storage/schema.js";
import type { CharacterPackage } from "./character-loader.js";
import {
	applyCharacterStateOperations,
	type CharacterStateDefinition,
	CharacterStateOperation,
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
		character: CharacterPackage;
	}) {
		const before = this.project(input.companionId, input.conversationId, input.definition);
		if (
			(input.expectedRevisions?.global !== undefined &&
				input.expectedRevisions.global !== before.revisions.global) ||
			(input.expectedRevisions?.conversation !== undefined &&
				input.expectedRevisions.conversation !== before.revisions.conversation)
		)
			throw { kind: "conflict", reason: "character_state_revision_conflict" };
		const beforeDisplay = this.snapshot(input.character, input.conversationId);
		const after = applyCompanionOperations({
			definition: input.definition,
			character: input.character,
			document: { character: before.document, display: beforeDisplay.display },
			operations: input.operations,
			authority: input.authority,
			evidence: input.evidence === true,
		});
		this.db.transaction((tx) => {
			for (const scope of ["global", "conversation"] as const) {
				const next = partition(after.character, input.definition, scope);
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
			if (!equal(beforeDisplay.display, after.display))
				this.save(
					tx,
					input.companionId,
					input.conversationId,
					"conversation",
					"display",
					after.display as unknown as Record<string, unknown>,
					beforeDisplay.revisions.display + 1,
					"display:v1",
				);
		});
		return {
			character: this.project(input.companionId, input.conversationId, input.definition),
			display: this.snapshot(input.character, input.conversationId),
		};
	}

	snapshot(character: CharacterPackage, conversationId: string): CompanionSnapshot {
		const row = this.row(character.id, conversationId, "conversation", "display");
		return {
			display: display(row?.stateJson, character),
			revisions: { display: row?.revision ?? 0 },
		};
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

function applyCompanionOperations(input: {
	definition: CharacterStateDefinition;
	character: CharacterPackage;
	document: { character: JsonObject; display: DisplayState };
	operations: CharacterStateOperation[];
	authority: "model" | "user" | `skill:${string}`;
	evidence: boolean;
}) {
	const next = structuredClone(input.document);
	for (const operation of input.operations.map((item) => CharacterStateOperation.parse(item))) {
		if (operation.path.startsWith("/character/")) {
			next.character = applyCharacterStateOperations({
				definition: input.definition,
				document: next.character,
				operations: [{ ...operation, path: operation.path.slice("/character".length) }],
				authority: input.authority,
				evidence: input.evidence,
			});
			continue;
		}
		if (!DISPLAY_POINTER.test(operation.path))
			throw { kind: "forbidden", reason: "state_write_not_authorized" };
		jsonPatch.applyPatch(next, [operation], true, true);
	}
	validateDisplay(next.display, input.character, next.character);
	return next;
}

const DISPLAY_POINTER =
	/^\/display\/(?:sceneId|expressionId|surfaces\/(?:ambient|inline|modal|choices))$/u;

function validateDisplay(value: unknown, character: CharacterPackage, state: JsonObject) {
	if (!record(value)) throw invalid("display_state_invalid");
	if (!declared(value.sceneId, character.scenes)) throw invalid("display_scene_not_declared");
	if (!declared(value.expressionId, character.visual.expressions))
		throw invalid("display_expression_not_declared");
	if (!record(value.surfaces)) throw invalid("display_state_invalid");
	const surfaces = value.surfaces;
	const keys = ["ambient", "inline", "modal", "choices"] as const;
	if (
		Object.keys(value).some((key) => !["sceneId", "expressionId", "surfaces"].includes(key)) ||
		Object.keys(surfaces).some((key) => !keys.includes(key as (typeof keys)[number])) ||
		keys.some((key) => !(key in surfaces))
	)
		throw invalid("display_state_invalid");
	for (const surface of keys) {
		const resourceId = surfaces[surface];
		if (resourceId === null) continue;
		if (typeof resourceId !== "string" || !resourceId) throw invalid("display_state_invalid");
		if (surface === "choices") {
			const choices = character.roleplay.choice_sets.find((item) => item.id === resourceId);
			if (!choices || !eligible(choices.when, state)) throw invalid("roleplay_choices_locked");
			continue;
		}
		const media = character.roleplay.media.find((item) => item.id === resourceId);
		const expected =
			media?.presentation === "ambient"
				? "ambient"
				: media?.presentation === "inline"
					? "inline"
					: "modal";
		if (!media || expected !== surface || !eligible(media.when, state))
			throw invalid("roleplay_media_locked");
	}
}

function eligible(
	condition: CharacterPackage["roleplay"]["media"][number]["when"],
	state: JsonObject,
): boolean {
	if (!condition) return true;
	if ("all" in condition) return condition.all.every((item) => eligible(item, state));
	if ("any" in condition) return condition.any.some((item) => eligible(item, state));
	if ("not" in condition) return !eligible(condition.not, state);
	if ("unlocked" in condition || "variable" in condition) return false;
	const actual = jsonPatch.getValueByPointer(state, condition.state);
	if ("equals" in condition)
		return Array.isArray(condition.equals)
			? condition.equals.includes(actual as never)
			: actual === condition.equals;
	return (
		typeof actual === "number" &&
		(condition.operator === "gt"
			? actual > condition.value
			: condition.operator === "gte"
				? actual >= condition.value
				: condition.operator === "lt"
					? actual < condition.value
					: actual <= condition.value)
	);
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
