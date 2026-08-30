import { z } from "@bear-harness/schema";
import Ajv2020Module, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import jsonPatch from "fast-json-patch";

export type StateScope = "conversation" | "global";
export type StateAuthority = "model" | "user" | "readonly" | `skill:${string}`;
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
	[key: string]: JsonValue;
}

/** Draft 2020-12 schema with a deliberately small Host authority vocabulary. */
export interface CharacterStateDefinition extends Record<string, unknown> {
	/** Non-enumerable compiled pointer index attached by CharacterStateSchema.parse. */
	readonly fields: Record<string, CharacterStateField>;
	$schema?: string;
	$defs?: Record<string, CharacterStateDefinition>;
	$ref?: string;
	type?: string | string[];
	default?: JsonValue;
	readOnly?: boolean;
	properties?: Record<string, CharacterStateDefinition>;
	additionalProperties?: boolean | CharacterStateDefinition;
	enum?: JsonValue[];
	const?: JsonValue;
	["x-scope"]?: StateScope;
	["x-write-authority"]?: StateAuthority;
	["x-evidence-required"]?: boolean;
	["x-allowed-transitions"]?: Array<[JsonValue, JsonValue]>;
	["x-incompatible-state"]?: "reject" | "reset";
}

export interface CharacterStateField {
	writeAuthority: StateAuthority;
	evidenceRequired: boolean;
	allowedTransitions?: Array<[JsonValue, JsonValue]>;
}

export interface CompiledCharacterStateSchema {
	definition: CharacterStateDefinition;
	partitions: ReadonlyMap<string, StateScope>;
	fields: ReadonlyMap<string, CharacterStateField>;
	validate: ValidateFunction;
}

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
const compiledCache = new WeakMap<object, CompiledCharacterStateSchema>();
const AUTHORITY = /^(?:model|user|readonly|skill:[a-z][a-z0-9-]{0,63})$/u;

export const CharacterStateSchema = {
	parse(input: unknown): CharacterStateDefinition {
		if (!isObject(input)) throw new Error("state_schema must be an object");
		const definition = input as CharacterStateDefinition;
		const compiled = compileCharacterStateSchema(definition);
		Object.defineProperty(definition, "fields", {
			value: Object.fromEntries(compiled.fields),
			enumerable: false,
			configurable: false,
			writable: false,
		});
		return definition;
	},
};

export function compileCharacterStateSchema(
	definition: CharacterStateDefinition,
): CompiledCharacterStateSchema {
	const cached = compiledCache.get(definition);
	if (cached) return cached;
	if (definition.$schema !== "https://json-schema.org/draft/2020-12/schema")
		throw new Error("state_schema must declare JSON Schema Draft 2020-12");
	if (definition.type !== "object") throw new Error("state_schema root must be an object");
	if (definition.additionalProperties !== false)
		throw new Error("state_schema root must reject additional properties");
	assertLocalRefsOnly(definition);
	const ajv = createAjv();
	if (!ajv.validateSchema(definition as AnySchema))
		throw new Error(`invalid state_schema: ${ajv.errorsText(ajv.errors)}`);
	const fields = new Map<string, CharacterStateField>();
	const partitions = new Map<string, StateScope>();
	for (const [name, child] of Object.entries(definition.properties ?? {})) {
		const scope = child["x-scope"];
		if (!scope) throw new Error(`state partition /${escapePointer(name)} has no x-scope`);
		const resolved = resolveRef(definition, child);
		if (resolved.type !== "object" && !resolved.properties)
			throw new Error(`state partition /${escapePointer(name)} must be an object`);
		partitions.set(name, scope);
		walk(definition, resolved, `/${escapePointer(name)}`, {}, fields, 1);
	}
	const result = {
		definition,
		partitions,
		fields,
		validate: ajv.compile(definition as AnySchema),
	};
	compiledCache.set(definition, result);
	return result;
}

function createAjv() {
	const instance = new Ajv2020({
		allErrors: true,
		strict: true,
		allowUnionTypes: true,
	});
	addFormats(instance);
	for (const keyword of [
		"x-scope",
		"x-model-readable",
		"x-write-authority",
		"x-evidence-required",
		"x-update-when",
		"x-do-not-update-when",
		"x-allowed-transitions",
		"x-user-editable",
		"x-hidden",
		"x-incompatible-state",
	])
		instance.addKeyword({ keyword, valid: true });
	return instance;
}

export function defaultStateDocument(definition: CharacterStateDefinition): JsonObject {
	const value = defaultValue(definition, definition, 0);
	if (!isObject(value)) throw new Error("state_schema root default is not an object");
	return value as JsonObject;
}

export const CharacterStateOperation = z.discriminatedUnion("op", [
	z.strictObject({
		op: z.literal("add"),
		path: z.string().min(1).max(512),
		value: z.unknown(),
	}),
	z.strictObject({
		op: z.literal("replace"),
		path: z.string().min(1).max(512),
		value: z.unknown(),
	}),
	z.strictObject({ op: z.literal("remove"), path: z.string().min(1).max(512) }),
	z.strictObject({
		op: z.literal("test"),
		path: z.string().min(1).max(512),
		value: z.unknown(),
	}),
]);
export type CharacterStateOperation = z.infer<typeof CharacterStateOperation>;

export function applyCharacterStateOperations(input: {
	definition: CharacterStateDefinition;
	document: JsonObject;
	operations: CharacterStateOperation[];
	authority: StateAuthority;
	evidence: boolean;
}): JsonObject {
	const next = structuredClone(input.document);
	const fields = compileCharacterStateSchema(input.definition).fields;
	for (const operation of input.operations.map((item) => CharacterStateOperation.parse(item))) {
		let candidate = operation.path;
		let field: CharacterStateField | undefined;
		while (candidate && !field) {
			field = fields.get(candidate);
			candidate = candidate.replace(/\/[^/]+$/u, "");
		}
		if (!field || field.writeAuthority !== input.authority)
			throw { kind: "forbidden", reason: "state_write_not_authorized" };
		if (field.evidenceRequired && !input.evidence)
			throw { kind: "forbidden", reason: "state_evidence_required" };
		const previous = jsonPatch.getValueByPointer(next, operation.path);
		if (
			operation.op !== "test" &&
			field.allowedTransitions?.length &&
			!field.allowedTransitions.some(
				([from, to]) =>
					JSON.stringify(from) === JSON.stringify(previous) &&
					"value" in operation &&
					JSON.stringify(to) === JSON.stringify(operation.value),
			)
		)
			throw {
				kind: "validation_failed",
				reason: "state_transition_not_allowed",
			};
		jsonPatch.applyPatch(next, [operation], true, true);
	}
	if (!compileCharacterStateSchema(input.definition).validate(next))
		throw { kind: "validation_failed", reason: "character_state_invalid" };
	return next;
}

interface Metadata {
	writeAuthority?: StateAuthority;
	evidenceRequired?: boolean;
}

function walk(
	root: CharacterStateDefinition,
	node: CharacterStateDefinition,
	pointer: string,
	inherited: Metadata,
	fields: Map<string, CharacterStateField>,
	depth: number,
): void {
	if (depth > 32) throw new Error("state_schema exceeds maximum depth");
	const current = resolveRef(root, node);
	if (depth > 1 && current["x-scope"])
		throw new Error(`state field ${pointer} may not override its partition x-scope`);
	const metadata = inherit(inherited, current);
	if (current.type === "object" || current.properties) {
		for (const [name, child] of Object.entries(current.properties ?? {}))
			walk(root, child, `${pointer}/${escapePointer(name)}`, metadata, fields, depth + 1);
		return;
	}
	if (!pointer) return;
	const writeAuthority = current.readOnly ? "readonly" : (metadata.writeAuthority ?? "readonly");
	if (!AUTHORITY.test(writeAuthority))
		throw new Error(`state field ${pointer} has invalid x-write-authority`);
	fields.set(pointer, {
		writeAuthority,
		evidenceRequired: metadata.evidenceRequired ?? false,
		...(current["x-allowed-transitions"]
			? { allowedTransitions: current["x-allowed-transitions"] }
			: {}),
	});
}

function inherit(parent: Metadata, node: CharacterStateDefinition): Metadata {
	return {
		...parent,
		...(node["x-write-authority"] ? { writeAuthority: node["x-write-authority"] } : {}),
		...(typeof node["x-evidence-required"] === "boolean"
			? { evidenceRequired: node["x-evidence-required"] }
			: {}),
	};
}

function defaultValue(
	root: CharacterStateDefinition,
	node: CharacterStateDefinition,
	depth: number,
): JsonValue {
	if (depth > 32) throw new Error("state_schema exceeds maximum depth");
	const current = resolveRef(root, node);
	if (current.default !== undefined) return structuredClone(current.default) as JsonValue;
	if (current.const !== undefined) return structuredClone(current.const) as JsonValue;
	if (current.type === "object" || current.properties)
		return Object.fromEntries(
			Object.entries(current.properties ?? {}).map(([name, child]) => [
				name,
				defaultValue(root, child, depth + 1),
			]),
		);
	if (current.type === "array") return [];
	if (current.enum?.length) return structuredClone(current.enum[0]) as JsonValue;
	if (current.type === "boolean") return false;
	if (current.type === "number" || current.type === "integer") return 0;
	if (current.type === "null") return null;
	return "";
}

function resolveRef(
	root: CharacterStateDefinition,
	node: CharacterStateDefinition,
): CharacterStateDefinition {
	if (!node.$ref) return node;
	let value: unknown = root;
	for (const segment of node.$ref.slice(2).split("/")) {
		if (!isObject(value)) throw new Error(`unresolved state_schema $ref ${node.$ref}`);
		value = value[unescapePointer(segment)];
	}
	if (!isObject(value)) throw new Error(`unresolved state_schema $ref ${node.$ref}`);
	return { ...(value as CharacterStateDefinition), ...node, $ref: undefined };
}

function assertLocalRefsOnly(value: unknown, depth = 0): void {
	if (depth > 64) throw new Error("state_schema exceeds maximum depth");
	if (Array.isArray(value)) {
		for (const child of value) assertLocalRefsOnly(child, depth + 1);
		return;
	}
	if (!isObject(value)) return;
	if (typeof value.$ref === "string" && !value.$ref.startsWith("#/"))
		throw new Error("state_schema only permits local $ref");
	for (const child of Object.values(value)) assertLocalRefsOnly(child, depth + 1);
}

function escapePointer(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
function unescapePointer(value: string): string {
	return value.replaceAll("~1", "/").replaceAll("~0", "~");
}
function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
