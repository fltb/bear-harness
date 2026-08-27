import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import {
	characterStateDocuments,
	pendingStateMutations,
	stateMutationLog,
} from "../storage/schema.js";
import {
	type CharacterStateDefinition,
	type CharacterStateField,
	type CharacterStateOperation,
	CharacterStateOperation as CharacterStateOperationSchema,
} from "./state-schema.js";

type StateScope = CharacterStateField["scope"];
type StateRevisions = Partial<Record<StateScope, number>>;

export interface CharacterStateProjection {
	values: Record<string, unknown>;
	schema: Record<string, CharacterStateField>;
	revisions: Record<StateScope, number>;
	schemaHash: string;
}

export interface CharacterStateCommitResult {
	state: CharacterStateProjection;
	committed: boolean;
}

export interface StageStateMutationInput {
	companionId: string;
	conversationId: string;
	piSessionId: string;
	sourceUserEntryId: string;
	definition: CharacterStateDefinition;
	operations: CharacterStateOperation[];
	expectedRevisions?: StateRevisions;
	reason: string;
}

/** Schema-authoritative state documents with durable turn-bound staging. */
export class CharacterStateService {
	constructor(private readonly db: AppDatabase) {}

	project(
		companionId: string,
		conversationId: string,
		definition: CharacterStateDefinition,
		modelOnly = false,
	): CharacterStateProjection {
		const schemaHash = hashDefinition(definition);
		const values: Record<string, unknown> = {};
		const schema: Record<string, CharacterStateField> = {};
		const revisions: Record<StateScope, number> = {
			conversation: 0,
			relationship: 0,
			character: 0,
		};
		for (const scope of ["conversation", "relationship", "character"] as const) {
			const row = this.document(companionId, conversationId, scope);
			if (row && row.schemaHash !== schemaHash)
				throw { kind: "conflict", reason: "character_state_schema_changed" };
			revisions[scope] = row?.revision ?? 0;
			for (const [path, field] of Object.entries(definition.fields)) {
				if (field.scope !== scope || (modelOnly && !field.model_readable)) continue;
				values[path] =
					row && Object.hasOwn(row.stateJson, path) ? row.stateJson[path] : field.initial;
				schema[path] = field;
			}
		}
		return { values, schema, revisions, schemaHash };
	}

	stage(input: StageStateMutationInput): { mutationId: string; status: "pending" } {
		if (input.operations.length === 0 || input.operations.length > 20)
			throw { kind: "validation_failed", reason: "state_operations_invalid" };
		const reason = input.reason.trim();
		if (!reason || reason.length > 1000)
			throw { kind: "validation_failed", reason: "state_reason_invalid" };
		const operations = CharacterStateOperationSchema.array().min(1).max(20).parse(input.operations);
		const projection = this.project(input.companionId, input.conversationId, input.definition);
		for (const [scope, expected] of Object.entries(input.expectedRevisions ?? {})) {
			if (projection.revisions[scope as StateScope] !== expected)
				throw { kind: "conflict", reason: "state_revision_conflict" };
		}
		const pending = this.db
			.select({ operations: pendingStateMutations.operationsJson })
			.from(pendingStateMutations)
			.where(
				and(
					eq(pendingStateMutations.conversationId, input.conversationId),
					eq(pendingStateMutations.piSessionId, input.piSessionId),
					eq(pendingStateMutations.sourceUserEntryId, input.sourceUserEntryId),
					eq(pendingStateMutations.status, "pending"),
				),
			)
			.all()
			.flatMap((row) => CharacterStateOperationSchema.array().parse(row.operations));
		let simulated = { ...projection.values };
		for (const operation of [...pending, ...operations])
			simulated = applyOperation(simulated, input.definition, operation, [
				...pending,
				...operations,
			]);

		const mutationId = randomUUID();
		this.db
			.insert(pendingStateMutations)
			.values({
				id: mutationId,
				companionId: input.companionId,
				conversationId: input.conversationId,
				piSessionId: input.piSessionId,
				sourceUserEntryId: input.sourceUserEntryId,
				operationsJson: operations,
				expectedRevisionsJson: input.expectedRevisions ?? {},
				reason,
				schemaHash: projection.schemaHash,
			})
			.run();
		return { mutationId, status: "pending" };
	}

	commitTurn(input: {
		companionId: string;
		conversationId: string;
		piSessionId: string;
		sourceUserEntryId: string;
		assistantEntryId: string;
		definition: CharacterStateDefinition;
	}): CharacterStateCommitResult {
		const mutations = this.db
			.select()
			.from(pendingStateMutations)
			.where(
				and(
					eq(pendingStateMutations.companionId, input.companionId),
					eq(pendingStateMutations.conversationId, input.conversationId),
					eq(pendingStateMutations.piSessionId, input.piSessionId),
					eq(pendingStateMutations.sourceUserEntryId, input.sourceUserEntryId),
					eq(pendingStateMutations.status, "pending"),
				),
			)
			.all();
		if (mutations.length === 0)
			return {
				state: this.project(input.companionId, input.conversationId, input.definition),
				committed: false,
			};
		const schemaHash = hashDefinition(input.definition);
		if (mutations.some((mutation) => mutation.schemaHash !== schemaHash))
			throw { kind: "conflict", reason: "character_state_schema_changed" };

		this.db.transaction((transaction) => {
			const before = this.project(input.companionId, input.conversationId, input.definition);
			for (const mutation of mutations) {
				for (const [scope, expected] of Object.entries(mutation.expectedRevisionsJson)) {
					if (before.revisions[scope as StateScope] !== expected)
						throw { kind: "conflict", reason: "state_revision_conflict" };
				}
			}
			let values = { ...before.values };
			const operations = mutations.flatMap((mutation) =>
				CharacterStateOperationSchema.array().parse(mutation.operationsJson),
			);
			for (const operation of operations)
				values = applyOperation(values, input.definition, operation, operations);
			const changedScopes = new Set(
				operations
					.map((operation) => input.definition.fields[operation.path]?.scope)
					.filter(Boolean),
			);
			const afterRevisions = { ...before.revisions };
			for (const scope of changedScopes) {
				if (!scope) continue;
				const stateJson = Object.fromEntries(
					Object.entries(input.definition.fields)
						.filter(([, field]) => field.scope === scope)
						.map(([path]) => [path, values[path]]),
				);
				const current = this.document(input.companionId, input.conversationId, scope);
				const nextRevision = (current?.revision ?? 0) + 1;
				const id = documentId(input.companionId, input.conversationId, scope);
				transaction
					.insert(characterStateDocuments)
					.values({
						id,
						companionId: input.companionId,
						...(scope === "conversation" ? { conversationId: input.conversationId } : {}),
						scope,
						stateJson,
						revision: nextRevision,
						schemaHash,
					})
					.onConflictDoUpdate({
						target: characterStateDocuments.id,
						set: { stateJson, revision: nextRevision, schemaHash, updatedAt: sql`datetime('now')` },
					})
					.run();
				afterRevisions[scope] = nextRevision;
			}
			for (const mutation of mutations) {
				transaction
					.update(pendingStateMutations)
					.set({
						status: "committed",
						assistantEntryId: input.assistantEntryId,
						committedAt: sql`datetime('now')`,
					})
					.where(eq(pendingStateMutations.id, mutation.id))
					.run();
				transaction
					.insert(stateMutationLog)
					.values({
						id: mutation.id,
						companionId: input.companionId,
						conversationId: input.conversationId,
						piSessionId: input.piSessionId,
						sourceUserEntryId: input.sourceUserEntryId,
						assistantEntryId: input.assistantEntryId,
						operationsJson: mutation.operationsJson,
						beforeRevisionsJson: before.revisions,
						afterRevisionsJson: afterRevisions,
						reason: mutation.reason,
					})
					.onConflictDoNothing()
					.run();
			}
		});
		return {
			state: this.project(input.companionId, input.conversationId, input.definition),
			committed: true,
		};
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
					eq(pendingStateMutations.status, "pending"),
				),
			)
			.run();
	}

	private document(companionId: string, conversationId: string, scope: StateScope) {
		return this.db
			.select()
			.from(characterStateDocuments)
			.where(
				and(
					eq(characterStateDocuments.companionId, companionId),
					eq(characterStateDocuments.scope, scope),
					scope === "conversation"
						? eq(characterStateDocuments.conversationId, conversationId)
						: isNull(characterStateDocuments.conversationId),
				),
			)
			.get();
	}
}

function applyOperation(
	values: Record<string, unknown>,
	definition: CharacterStateDefinition,
	operation: CharacterStateOperation,
	turnOperations: CharacterStateOperation[],
): Record<string, unknown> {
	const field = definition.fields[operation.path];
	if (!field) throw { kind: "validation_failed", reason: "state_path_not_declared" };
	if (!field.model_writable || !field.operations.includes(operation.op))
		throw { kind: "forbidden", reason: "state_operation_not_allowed" };
	const current = values[operation.path] ?? field.initial;
	let next: unknown;
	if (operation.op === "clear") next = field.initial;
	else if (operation.op === "increment" || operation.op === "decrement") {
		if (typeof current !== "number" || typeof operation.value !== "number")
			throw { kind: "validation_failed", reason: "state_value_type_invalid" };
		const delta = operation.op === "increment" ? operation.value : -operation.value;
		next = current + delta;
		if (field.max_change_per_turn !== undefined) {
			const total = turnOperations
				.filter((candidate) => candidate.path === operation.path)
				.reduce((sum, candidate) => {
					if (
						typeof candidate.value !== "number" ||
						(candidate.op !== "increment" && candidate.op !== "decrement")
					)
						return sum;
					return sum + (candidate.op === "decrement" ? -candidate.value : candidate.value);
				}, 0);
			if (Math.abs(total) > field.max_change_per_turn)
				throw { kind: "forbidden", reason: "state_turn_change_exceeded" };
		}
	} else if (operation.op === "append_unique" || operation.op === "remove_value") {
		if (!Array.isArray(current) || typeof operation.value !== "string")
			throw { kind: "validation_failed", reason: "state_value_type_invalid" };
		next =
			operation.op === "append_unique"
				? current.includes(operation.value)
					? current
					: [...current, operation.value]
				: current.filter((value) => value !== operation.value);
	} else next = operation.value;
	validateValue(field, current, next);
	return { ...values, [operation.path]: next };
}

function validateValue(field: CharacterStateField, current: unknown, value: unknown): void {
	const expected = field.type === "enum" || field.type === "string" ? "string" : field.type;
	const actual = Array.isArray(value) ? "string_list" : typeof value;
	if (actual !== expected) throw { kind: "validation_failed", reason: "state_value_type_invalid" };
	if (
		field.type === "string_list" &&
		!(value as unknown[]).every((item) => typeof item === "string")
	)
		throw { kind: "validation_failed", reason: "state_value_type_invalid" };
	if (field.type === "enum" && !field.values?.includes(String(value)))
		throw { kind: "validation_failed", reason: "state_enum_invalid" };
	if (typeof value === "number") {
		if (field.minimum !== undefined && value < field.minimum)
			throw { kind: "validation_failed", reason: "state_value_out_of_range" };
		if (field.maximum !== undefined && value > field.maximum)
			throw { kind: "validation_failed", reason: "state_value_out_of_range" };
	}
	if (
		field.allowed_transitions &&
		!field.allowed_transitions.some(
			([from, to]) => Object.is(from, current) && Object.is(to, value),
		)
	)
		throw { kind: "conflict", reason: "state_transition_not_allowed" };
}

function hashDefinition(definition: CharacterStateDefinition): string {
	return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function documentId(companionId: string, conversationId: string, scope: StateScope): string {
	return scope === "conversation"
		? `${companionId}:conversation:${conversationId}`
		: `${companionId}:${scope}`;
}
