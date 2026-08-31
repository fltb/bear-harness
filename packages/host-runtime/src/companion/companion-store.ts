import { createHash } from "node:crypto";
import type { CompanionConversationState, CompanionDisplayState } from "@bear-harness/protocol";
import * as Protocol from "@bear-harness/protocol/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import jsonPatch from "fast-json-patch";
import type { AppDatabase } from "../storage/database.js";
import { companionStateDocuments } from "../storage/schema.js";
import type { CharacterPackage } from "./character-loader.js";
import {
	applyCharacterStateChanges,
	CharacterStateChange,
	type CharacterStateDefinition,
	compileCharacterStateSchema,
	type JsonObject,
	type StateScope,
} from "./state-schema.js";

type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
const table = companionStateDocuments;
type Row = typeof table.$inferSelect;
type Write = Omit<typeof table.$inferInsert, "id">;
type WriteInput = {
	companionId: string;
	conversationId: string;
	definition: CharacterStateDefinition;
	changes: CharacterStateChange[];
	character: CharacterPackage;
};
export type DisplayState = CompanionDisplayState;
export type CompanionSnapshot = Pick<CompanionConversationState, "display" | "revisions">;
const SCOPES = ["global", "conversation"] as const;
const DISPLAY_PATH = /^\/display\/(?:sceneId|expressionId)$/u;
export class CompanionStateStore {
	constructor(private readonly db: AppDatabase) {}
	project(companionId: string, conversationId: string, definition: CharacterStateDefinition) {
		return projection(this.rows(companionId, conversationId), definition);
	}
	snapshot(character: CharacterPackage, conversationId: string): CompanionSnapshot {
		return displaySnapshot(this.rows(character.id, conversationId), character);
	}
	writeCompanion(input: WriteInput) {
		const rows = this.rows(input.companionId, input.conversationId);
		const before = projection(rows, input.definition);
		const beforeDisplay = displaySnapshot(rows, input.character);
		const changes = input.changes.map((item) => CharacterStateChange.parse(item));
		const characterChanges = changes.filter(({ path }) => path.startsWith("/character/"));
		const displayChanges = changes.filter(({ path }) => DISPLAY_PATH.test(path));
		if (characterChanges.length + displayChanges.length !== changes.length)
			throw invalid("state_path_invalid");
		const character = applyCharacterStateChanges({
			...input,
			document: before.document,
			changes: characterChanges,
			prefix: "/character",
		});
		const displayDocument = { display: structuredClone(beforeDisplay.display) };
		jsonPatch.applyPatch(
			displayDocument,
			displayChanges.map(({ path, value }) => ({ op: "replace" as const, path, value })),
			true,
			true,
		);
		const { display } = displayDocument;
		validateDisplay(display, input.character);
		this.db.transaction((tx) => {
			for (const scope of SCOPES) {
				const stateJson = partition(character, input.definition, scope);
				if (equal(stateJson, partition(before.document, input.definition, scope))) continue;
				const conversationId = scope === "global" ? null : input.conversationId;
				this.save(tx, {
					companionId: input.companionId,
					conversationId,
					scope,
					domain: "character",
					stateJson,
					revision: before.revisions[scope] + 1,
					schemaHash: before.schemaHash,
				});
			}
			if (equal(display, beforeDisplay.display)) return;
			this.save(tx, {
				companionId: input.companionId,
				conversationId: input.conversationId,
				scope: "conversation",
				domain: "display",
				stateJson: display as unknown as Record<string, unknown>,
				revision: beforeDisplay.revisions.display + 1,
				schemaHash: "display:v1",
			});
		});
	}
	reconcileSchema(companionId: string, definition: CharacterStateDefinition) {
		const owned = and(eq(table.companionId, companionId), eq(table.domain, "character"));
		const rows = this.db.select().from(table).where(owned).all();
		const schemaHash = hash(definition);
		const changed = rows.filter((row) => row.schemaHash !== schemaHash);
		if (!changed.length) return { status: "unchanged" as const, documents: 0 };
		if (definition["x-incompatible-state"] !== "reset")
			throw { kind: "conflict", reason: "character_state_schema_changed" };
		this.db.delete(table).where(owned).run();
		return { status: "reset" as const, documents: changed.length };
	}
	private rows(companionId: string, conversationId: string) {
		const owned = and(
			eq(table.companionId, companionId),
			or(isNull(table.conversationId), eq(table.conversationId, conversationId)),
		);
		return this.db.select().from(table).where(owned).all();
	}
	private save(tx: Tx, values: Write) {
		const id = `${values.companionId}:${values.domain}:${values.conversationId ?? "global"}`;
		const set = { ...values, updatedAt: sql`datetime('now')` };
		tx.insert(table)
			.values({ ...values, id })
			.onConflictDoUpdate({ target: table.id, set })
			.run();
	}
}
function projection(rows: Row[], definition: CharacterStateDefinition) {
	const character = rows.filter((row) => row.domain === "character");
	const global = character.find((row) => row.scope === "global");
	const conversation = character.find((row) => row.scope === "conversation");
	const schemaHash = hash(definition);
	if ([global, conversation].some((row) => row && row.schemaHash !== schemaHash))
		throw { kind: "conflict", reason: "character_state_schema_changed" };
	const compiled = compileCharacterStateSchema(definition);
	const document = {
		...structuredClone(compiled.defaults),
		...(global?.stateJson ?? {}),
		...(conversation?.stateJson ?? {}),
	} as JsonObject;
	if (!compiled.validate(document)) throw invalid("character_state_invalid");
	return {
		document,
		revisions: { global: global?.revision ?? 0, conversation: conversation?.revision ?? 0 },
		schemaHash,
	};
}
function displaySnapshot(rows: Row[], character: CharacterPackage): CompanionSnapshot {
	const row = rows.find((item) => item.domain === "display");
	const display = row?.stateJson ?? {
		sceneId: character.visual.default_scene,
		expressionId: character.visual.default_expression,
	};
	const revisions = { display: row?.revision ?? 0 };
	return { display: structuredClone(display) as DisplayState, revisions };
}
function validateDisplay(value: unknown, character: CharacterPackage) {
	const parsed = Protocol.CompanionDisplayState.safeParse(value);
	if (!parsed.success) throw invalid("display_state_invalid");
	const display = parsed.data;
	if (!declared(display.sceneId, character.scenes)) throw invalid("display_scene_not_declared");
	if (!declared(display.expressionId, character.visual.expressions))
		throw invalid("display_expression_not_declared");
}
function partition(document: JsonObject, definition: CharacterStateDefinition, scope: StateScope) {
	const entries = [...compileCharacterStateSchema(definition).partitions]
		.filter(([, value]) => value === scope)
		.map(([name]) => [name, structuredClone(document[name])]);
	return Object.fromEntries(entries) as JsonObject;
}
const declared = (value: unknown, items: Array<{ id: string }>): value is string =>
	typeof value === "string" && items.some((item) => item.id === value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const invalid = (reason: string) => ({ kind: "validation_failed", reason });
