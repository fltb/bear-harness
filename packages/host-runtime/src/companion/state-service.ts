import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import jsonPatch from "fast-json-patch";
import type { AppDatabase } from "../storage/database.js";
import {
	characterStateDocuments,
	pendingStateMutations,
	stateMutationLog,
} from "../storage/schema.js";
import {
	type CharacterStateDefinition,
	type CharacterStateEvidence,
	type CharacterStateField,
	type CharacterStateOperation,
	CharacterStateOperation as CharacterStateOperationSchema,
	compileCharacterStateSchema,
	defaultStateDocument,
	type JsonObject,
	type StateScope,
	stateFieldForPointer,
} from "./state-schema.js";

type StateRevisions = Partial<Record<StateScope, number>>;
const { applyPatch, getValueByPointer } = jsonPatch;
type AppTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
type MutationAuthority = "model" | "user";

export interface CharacterStateProjection {
	document: JsonObject;
	schema: CharacterStateDefinition;
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
	skillId?: string;
	evidence?: CharacterStateEvidence;
}

export interface CharacterStateReconciliation {
	status: "unchanged" | "migrated" | "reset";
	documents: number;
}

interface DurableStateOperation {
	operation: CharacterStateOperation;
	authority: MutationAuthority;
	skillId?: string;
	evidence?: CharacterStateEvidence;
}

/** Recursive JSON-Schema state documents with durable, turn-bound JSON Patch staging. */
export class CharacterStateService {
	constructor(private readonly db: AppDatabase) {}

	/**
	 * Reconcile persisted documents when a package changes its JSON Schema.
	 * Compatible changes retain data and only advance the schema hash. A package
	 * must opt in explicitly before incompatible pre-release state may be reset.
	 */
	reconcileSchema(
		companionId: string,
		definition: CharacterStateDefinition,
	): CharacterStateReconciliation {
		const schemaHash = hashDefinition(definition);
		const rows = this.db
			.select()
			.from(characterStateDocuments)
			.where(
				and(
					eq(characterStateDocuments.companionId, companionId),
					eq(characterStateDocuments.domain, "character"),
				),
			)
			.all()
			.filter((mutation) => mutation.schemaHash !== "companion:v1");
		const incompatible = rows.filter((row) => row.schemaHash !== schemaHash);
		if (incompatible.length === 0) return { status: "unchanged", documents: 0 };

		const candidate = defaultStateDocument(definition);
		for (const row of rows) mergeJson(candidate, row.stateJson as JsonObject);
		const validate = compileCharacterStateSchema(definition).validate;
		if (validate(candidate)) {
			this.db
				.update(characterStateDocuments)
				.set({ schemaHash, updatedAt: sql`datetime('now')` })
				.where(
					and(
						eq(characterStateDocuments.companionId, companionId),
						eq(characterStateDocuments.domain, "character"),
					),
				)
				.run();
			return { status: "migrated", documents: incompatible.length };
		}

		if (definition["x-incompatible-state"] !== "reset")
			throw { kind: "conflict", reason: "character_state_schema_changed" };
		this.db.transaction((transaction) => {
			transaction
				.delete(characterStateDocuments)
				.where(
					and(
						eq(characterStateDocuments.companionId, companionId),
						eq(characterStateDocuments.domain, "character"),
					),
				)
				.run();
			transaction
				.update(pendingStateMutations)
				.set({ status: "discarded" })
				.where(
					and(
						eq(pendingStateMutations.companionId, companionId),
						eq(pendingStateMutations.status, "pending"),
					),
				)
				.run();
		});
		return { status: "reset", documents: incompatible.length };
	}

	project(
		companionId: string,
		conversationId: string,
		definition: CharacterStateDefinition,
		modelOnly = false,
	): CharacterStateProjection {
		const compiled = compileCharacterStateSchema(definition);
		const schemaHash = hashDefinition(definition);
		const document = defaultStateDocument(definition);
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
			if (row) mergeJson(document, row.stateJson as JsonObject);
		}
		assertValid(compiled.validate, document);
		return {
			document: modelOnly ? projectReadableDocument(document, definition) : document,
			schema: definition,
			revisions,
			schemaHash,
		};
	}

	stage(input: StageStateMutationInput): {
		mutationId: string;
		status: "pending";
	} {
		const operations = parseOperations(input.operations);
		const reason = validReason(input.reason);
		const projection = this.project(input.companionId, input.conversationId, input.definition);
		// Model-facing RPCs submit intent, not concurrency metadata. Bind the
		// transaction to the Host's authoritative snapshot at receipt time.
		const expectedRevisions = input.expectedRevisions ?? projection.revisions;
		assertRevisions(projection.revisions, expectedRevisions);
		const pending = this.pendingOperations(
			input.conversationId,
			input.piSessionId,
			input.sourceUserEntryId,
		);
		const additions: DurableStateOperation[] = operations.map((operation) => ({
			operation,
			authority: "model",
			...(input.skillId ? { skillId: input.skillId } : {}),
			...(input.evidence ? { evidence: input.evidence } : {}),
		}));
		applyOperations(projection.document, input.definition, [...pending, ...additions], false);
		const mutationId = randomUUID();
		this.db
			.insert(pendingStateMutations)
			.values({
				id: mutationId,
				companionId: input.companionId,
				conversationId: input.conversationId,
				piSessionId: input.piSessionId,
				sourceUserEntryId: input.sourceUserEntryId,
				operationsJson: additions as unknown as Array<Record<string, unknown>>,
				expectedRevisionsJson: expectedRevisions,
				reason,
				schemaHash: projection.schemaHash,
			})
			.run();
		return { mutationId, status: "pending" };
	}

	commitUserPatch(input: {
		companionId: string;
		conversationId: string;
		definition: CharacterStateDefinition;
		expectedRevisions: StateRevisions;
		operations: CharacterStateOperation[];
		sourceId: string;
	}): CharacterStateProjection {
		return this.commitUserPatchInternal({
			...input,
			reason: "User edited the schema-declared conversation state form.",
		});
	}

	/** Explicit user edits commit directly, outside model turn staging. */
	private commitUserPatchInternal(input: {
		companionId: string;
		conversationId: string;
		definition: CharacterStateDefinition;
		sourceId: string;
		operations: CharacterStateOperation[];
		reason: string;
		expectedRevisions?: StateRevisions;
		transaction?: AppTransaction;
	}): CharacterStateProjection {
		const existing = this.db
			.select({ id: stateMutationLog.id })
			.from(stateMutationLog)
			.where(eq(stateMutationLog.id, input.sourceId))
			.get();
		if (existing) return this.project(input.companionId, input.conversationId, input.definition);
		const operations = parseOperations(input.operations);
		const reason = validReason(input.reason);
		const before = this.project(input.companionId, input.conversationId, input.definition);
		assertRevisions(before.revisions, input.expectedRevisions);
		const entries = operations.map((operation) => ({
			operation,
			authority: "user" as const,
		}));
		const afterDocument = applyOperations(before.document, input.definition, entries, false);
		const changed = operations.filter(
			(operation) =>
				!deepEqual(
					getValueByPointer(before.document, operationField(input.definition, operation).pointer),
					getValueByPointer(afterDocument, operationField(input.definition, operation).pointer),
				),
		);
		if (changed.length === 0) return before;
		const persist = (transaction: AppTransaction) =>
			this.persist({
				transaction,
				companionId: input.companionId,
				conversationId: input.conversationId,
				definition: input.definition,
				before,
				afterDocument,
				operations: changed,
				logEntries: [
					{
						id: input.sourceId,
						piSessionId: "host:user",
						sourceUserEntryId: input.sourceId,
						assistantEntryId: input.sourceId,
						operationsJson: changed as unknown as Array<Record<string, unknown>>,
						reason,
					},
				],
			});
		if (input.transaction) persist(input.transaction);
		else this.db.transaction((transaction) => persist(transaction));
		return this.project(input.companionId, input.conversationId, input.definition);
	}

	commitTurn(input: {
		companionId: string;
		conversationId: string;
		piSessionId: string;
		sourceUserEntryId: string;
		assistantEntryId: string;
		definition: CharacterStateDefinition;
		transaction?: AppTransaction;
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
			.all()
			.filter((mutation) => mutation.schemaHash !== "companion:v1");
		if (mutations.length === 0)
			return {
				state: this.project(input.companionId, input.conversationId, input.definition),
				committed: false,
			};
		const before = this.project(input.companionId, input.conversationId, input.definition);
		if (mutations.some((mutation) => mutation.schemaHash !== before.schemaHash))
			throw { kind: "conflict", reason: "character_state_schema_changed" };
		for (const mutation of mutations)
			assertRevisions(before.revisions, mutation.expectedRevisionsJson as StateRevisions);
		const entries = mutations.flatMap((mutation) =>
			parseDurableOperations(mutation.operationsJson),
		);
		const afterDocument = applyOperations(before.document, input.definition, entries, true);
		const operations = entries.map((entry) => entry.operation);
		const persist = (transaction: AppTransaction) => {
			this.persist({
				transaction,
				companionId: input.companionId,
				conversationId: input.conversationId,
				definition: input.definition,
				before,
				afterDocument,
				operations,
				logEntries: mutations.map((mutation) => ({
					id: mutation.id,
					piSessionId: input.piSessionId,
					sourceUserEntryId: input.sourceUserEntryId,
					assistantEntryId: input.assistantEntryId,
					operationsJson: mutation.operationsJson,
					reason: mutation.reason,
				})),
			});
			for (const mutation of mutations)
				transaction
					.update(pendingStateMutations)
					.set({
						status: "committed",
						assistantEntryId: input.assistantEntryId,
						committedAt: sql`datetime('now')`,
					})
					.where(eq(pendingStateMutations.id, mutation.id))
					.run();
		};
		if (input.transaction) persist(input.transaction);
		else this.db.transaction((transaction) => persist(transaction));
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

	previewTurn(input: {
		companionId: string;
		conversationId: string;
		piSessionId: string;
		sourceUserEntryId: string;
		definition: CharacterStateDefinition;
	}): CharacterStateProjection {
		const projection = this.project(input.companionId, input.conversationId, input.definition);
		const entries = this.pendingOperations(
			input.conversationId,
			input.piSessionId,
			input.sourceUserEntryId,
		);
		if (entries.length === 0) return projection;
		return {
			...projection,
			document: applyOperations(projection.document, input.definition, entries, true),
		};
	}

	/** Rebuild conversation-scoped state from mutations on one native Pi branch. */
	forkConversation(input: {
		companionId: string;
		sourceConversationId: string;
		targetConversationId: string;
		targetPiSessionId: string;
		definition: CharacterStateDefinition;
		sourceEntryIds: Set<string>;
	}): void {
		const rows = this.db
			.select()
			.from(stateMutationLog)
			.where(
				and(
					eq(stateMutationLog.companionId, input.companionId),
					eq(stateMutationLog.conversationId, input.sourceConversationId),
				),
			)
			.all()
			.filter((row) => isCharacterMutationLog(row.operationsJson))
			.map((row) => ({ row, authoritativeId: undefined as string | undefined }))
			.filter(
				(entry) =>
					entry.authoritativeId !== undefined ||
					input.sourceEntryIds.has(entry.row.sourceUserEntryId) ||
					input.sourceEntryIds.has(entry.row.assistantEntryId),
			)
			.sort((left, right) => {
				const leftRevision = (left.row.afterRevisionsJson as StateRevisions).conversation ?? 0;
				const rightRevision = (right.row.afterRevisionsJson as StateRevisions).conversation ?? 0;
				return (
					leftRevision - rightRevision || left.row.createdAt.localeCompare(right.row.createdAt)
				);
			});

		let document = defaultStateDocument(input.definition);
		let revision = 0;
		const selected = rows.flatMap((entry) => {
			const raw = entry.row.operationsJson;
			const first = raw[0];
			if (entry.row.piSessionId.startsWith("host:host_event")) return [];
			const operations =
				first && "operation" in first
					? parseDurableOperations(raw)
					: parseOperations(raw).map((operation) => ({ operation, authority: "user" as const }));
			const scoped = operations.filter(
				(operation) =>
					operationField(input.definition, operation.operation).scope === "conversation",
			);
			if (scoped.length === 0) return [];
			document = applyOperations(document, input.definition, scoped, true);
			revision = Math.max(
				revision,
				(entry.row.afterRevisionsJson as StateRevisions).conversation ?? revision,
			);
			return [entry];
		});
		if (selected.length === 0) return;

		const schemaHash = hashDefinition(input.definition);
		this.db.transaction((transaction) => {
			transaction
				.insert(characterStateDocuments)
				.values({
					id: documentId(input.companionId, input.targetConversationId, "conversation"),
					companionId: input.companionId,
					conversationId: input.targetConversationId,
					scope: "conversation",
					domain: "character",
					stateJson: scopeDocument(document, input.definition, "conversation"),
					revision,
					schemaHash,
				})
				.run();
			for (const { row, authoritativeId } of selected) {
				const id = authoritativeId ?? randomUUID();
				transaction
					.insert(stateMutationLog)
					.values({
						...row,
						id,
						conversationId: input.targetConversationId,
						piSessionId: authoritativeId ? row.piSessionId : input.targetPiSessionId,
						...(authoritativeId ? { sourceUserEntryId: id, assistantEntryId: id } : {}),
					})
					.run();
			}
		});
	}

	private pendingOperations(
		conversationId: string,
		piSessionId: string,
		sourceUserEntryId: string,
	): DurableStateOperation[] {
		return this.db
			.select({ operations: pendingStateMutations.operationsJson })
			.from(pendingStateMutations)
			.where(
				and(
					eq(pendingStateMutations.conversationId, conversationId),
					eq(pendingStateMutations.piSessionId, piSessionId),
					eq(pendingStateMutations.sourceUserEntryId, sourceUserEntryId),
					eq(pendingStateMutations.status, "pending"),
				),
			)
			.all()
			.filter((row) => row.operations.length > 0 && "operation" in row.operations[0]!)
			.flatMap((row) => parseDurableOperations(row.operations));
	}

	private persist(input: {
		transaction: AppTransaction;
		companionId: string;
		conversationId: string;
		definition: CharacterStateDefinition;
		before: CharacterStateProjection;
		afterDocument: JsonObject;
		operations: CharacterStateOperation[];
		logEntries: Array<{
			id: string;
			piSessionId: string;
			sourceUserEntryId: string;
			assistantEntryId: string;
			operationsJson: Array<Record<string, unknown>>;
			reason: string;
		}>;
	}): void {
		const scopes = new Set(
			input.operations.map((operation) => operationField(input.definition, operation).scope),
		);
		const afterRevisions = { ...input.before.revisions };
		for (const scope of scopes) {
			const stateJson = scopeDocument(input.afterDocument, input.definition, scope);
			const current = this.document(input.companionId, input.conversationId, scope);
			const revision = (current?.revision ?? 0) + 1;
			input.transaction
				.insert(characterStateDocuments)
				.values({
					id: documentId(input.companionId, input.conversationId, scope),
					companionId: input.companionId,
					...(scope === "conversation" ? { conversationId: input.conversationId } : {}),
					scope,
					domain: "character",
					stateJson,
					revision,
					schemaHash: input.before.schemaHash,
				})
				.onConflictDoUpdate({
					target: characterStateDocuments.id,
					set: {
						stateJson,
						revision,
						schemaHash: input.before.schemaHash,
						updatedAt: sql`datetime('now')`,
					},
				})
				.run();
			afterRevisions[scope] = revision;
		}
		for (const entry of input.logEntries)
			input.transaction
				.insert(stateMutationLog)
				.values({
					...entry,
					companionId: input.companionId,
					conversationId: input.conversationId,
					beforeRevisionsJson: input.before.revisions,
					afterRevisionsJson: afterRevisions,
				})
				.onConflictDoNothing()
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
					eq(characterStateDocuments.domain, "character"),
					scope === "conversation"
						? eq(characterStateDocuments.conversationId, conversationId)
						: isNull(characterStateDocuments.conversationId),
				),
			)
			.get();
	}
}

function isCharacterMutationLog(value: unknown): value is Array<Record<string, unknown>> {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => Boolean(entry && typeof entry === "object" && "operation" in entry))
	);
}

function applyOperations(
	base: JsonObject,
	definition: CharacterStateDefinition,
	entries: DurableStateOperation[],
	prevalidated: boolean,
): JsonObject {
	let document = structuredClone(base);
	for (const entry of entries) {
		const field = operationField(definition, entry.operation);
		if (!prevalidated) assertAuthority(field, entry);
		const previous = structuredClone(getValueByPointer(document, field.pointer));
		try {
			document = applyPatch(document, [entry.operation], true, false).newDocument as JsonObject;
		} catch {
			throw { kind: "validation_failed", reason: "state_patch_invalid" };
		}
		const next = getValueByPointer(document, field.pointer);
		if (
			field.allowedTransitions &&
			!deepEqual(previous, next) &&
			!field.allowedTransitions.some(
				([from, to]) => deepEqual(previous, from) && deepEqual(next, to),
			)
		)
			throw { kind: "conflict", reason: "state_transition_not_allowed" };
		if (
			field.maxChangePerTurn !== undefined &&
			typeof getValueByPointer(base, field.pointer) === "number" &&
			typeof next === "number" &&
			Math.abs((next as number) - (getValueByPointer(base, field.pointer) as number)) >
				field.maxChangePerTurn
		)
			throw { kind: "forbidden", reason: "state_turn_change_exceeded" };
	}
	assertValid(compileCharacterStateSchema(definition).validate, document);
	return document;
}

function assertAuthority(field: CharacterStateField, entry: DurableStateOperation): void {
	if (entry.operation.op === "test") {
		if (!field.modelReadable) throw { kind: "forbidden", reason: "state_operation_not_allowed" };
		return;
	}
	const authorized =
		field.writeAuthority === entry.authority ||
		(field.writeAuthority.startsWith("skill:") &&
			field.writeAuthority.slice("skill:".length) === entry.skillId);
	if (!authorized) throw { kind: "forbidden", reason: "state_operation_not_allowed" };
	if (entry.authority === "model" && field.evidenceRequired && !entry.evidence)
		throw { kind: "validation_failed", reason: "state_evidence_required" };
}

function operationField(
	definition: CharacterStateDefinition,
	operation: CharacterStateOperation,
): CharacterStateField {
	const field = stateFieldForPointer(definition, operation.path);
	if (!field) throw { kind: "validation_failed", reason: "state_path_not_declared" };
	return field;
}

function scopeDocument(
	document: JsonObject,
	definition: CharacterStateDefinition,
	scope: StateScope,
): JsonObject {
	const result: JsonObject = {};
	for (const field of compileCharacterStateSchema(definition).fields.values()) {
		if (field.scope !== scope) continue;
		setPointer(result, field.pointer, structuredClone(getValueByPointer(document, field.pointer)));
	}
	return result;
}

function projectReadableDocument(
	document: JsonObject,
	definition: CharacterStateDefinition,
): JsonObject {
	const result: JsonObject = {};
	for (const field of compileCharacterStateSchema(definition).fields.values()) {
		if (!field.modelReadable) continue;
		setPointer(result, field.pointer, structuredClone(getValueByPointer(document, field.pointer)));
	}
	return result;
}

function setPointer(target: JsonObject, pointer: string, value: unknown): void {
	const segments = pointer
		.slice(1)
		.split("/")
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
	let current: JsonObject = target;
	for (const segment of segments.slice(0, -1)) {
		const existing = current[segment];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[segment] = {};
		current = current[segment] as JsonObject;
	}
	const last = segments.at(-1);
	if (last) current[last] = value as never;
}

function mergeJson(target: JsonObject, source: JsonObject): void {
	for (const [key, value] of Object.entries(source)) {
		if (isJsonObject(value) && isJsonObject(target[key])) mergeJson(target[key], value);
		else target[key] = structuredClone(value);
	}
}

function parseOperations(value: unknown): CharacterStateOperation[] {
	return CharacterStateOperationSchema.array().min(1).max(20).parse(value);
}

function parseDurableOperations(value: unknown): DurableStateOperation[] {
	if (!Array.isArray(value))
		throw { kind: "validation_failed", reason: "state_operations_invalid" };
	return value.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("operation" in entry))
			throw { kind: "validation_failed", reason: "state_operations_invalid" };
		const record = entry as Record<string, unknown>;
		const authority = record.authority;
		if (authority !== "model" && authority !== "user")
			throw { kind: "validation_failed", reason: "state_operations_invalid" };
		return {
			operation: CharacterStateOperationSchema.parse(record.operation),
			authority,
			...(typeof record.skillId === "string" ? { skillId: record.skillId } : {}),
			...(isEvidence(record.evidence) ? { evidence: record.evidence } : {}),
		};
	});
}

function assertRevisions(
	actual: Record<StateScope, number>,
	expected: StateRevisions | undefined,
): void {
	for (const [scope, revision] of Object.entries(expected ?? {}))
		if (actual[scope as StateScope] !== revision)
			throw { kind: "conflict", reason: "state_revision_conflict" };
}

function assertValid(
	validate: ReturnType<typeof compileCharacterStateSchema>["validate"],
	value: unknown,
) {
	if (!validate(value))
		throw {
			kind: "validation_failed",
			reason: "state_schema_validation_failed",
		};
}

function validReason(value: string): string {
	const reason = value.trim();
	if (!reason || reason.length > 1000)
		throw { kind: "validation_failed", reason: "state_reason_invalid" };
	return reason;
}

function isEvidence(value: unknown): value is CharacterStateEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.source === "current_user" || record.source === "current_assistant") &&
		typeof record.quote === "string"
	);
}

function hashDefinition(definition: CharacterStateDefinition): string {
	return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}
function documentId(companionId: string, conversationId: string, scope: StateScope): string {
	return scope === "conversation"
		? `${companionId}:conversation:${conversationId}`
		: `${companionId}:${scope}`;
}
function deepEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
function isJsonObject(value: unknown): value is JsonObject {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
