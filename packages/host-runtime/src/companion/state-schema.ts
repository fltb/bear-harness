import { z } from "@bear-harness/schema";
import Ajv2020Module, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

export type StateScope = "conversation" | "relationship" | "character";
export type StateAuthority =
	| "model"
	| "host_event"
	| "user_choice"
	| "user"
	| "readonly"
	| `skill:${string}`;
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
	[key: string]: JsonValue;
}

/** Draft 2020-12 schema with a deliberately small Host authority vocabulary. */
export interface CharacterStateDefinition extends Record<string, unknown> {
	/** Non-enumerable compiled pointer index attached by CharacterStateSchema.parse. */
	readonly fields: Record<string, CharacterStateField>;
	$schema?: string;
	$id?: string;
	$defs?: Record<string, CharacterStateDefinition>;
	$ref?: string;
	type?: string | string[];
	title?: string;
	description?: string;
	$comment?: string;
	default?: JsonValue;
	readOnly?: boolean;
	properties?: Record<string, CharacterStateDefinition>;
	items?: CharacterStateDefinition;
	prefixItems?: CharacterStateDefinition[];
	required?: string[];
	additionalProperties?: boolean | CharacterStateDefinition;
	enum?: JsonValue[];
	const?: JsonValue;
	oneOf?: CharacterStateDefinition[];
	anyOf?: CharacterStateDefinition[];
	allOf?: CharacterStateDefinition[];
	["x-scope"]?: StateScope;
	["x-model-readable"]?: boolean;
	["x-write-authority"]?: StateAuthority;
	["x-deterministic-authorities"]?: Array<"host_event" | "user_choice">;
	["x-evidence-required"]?: boolean;
	["x-update-when"]?: string[];
	["x-do-not-update-when"]?: string[];
	["x-max-change-per-turn"]?: number;
	["x-allowed-transitions"]?: Array<[JsonValue, JsonValue]>;
	["x-user-editable"]?: boolean;
	["x-hidden"]?: boolean;
	["x-incompatible-state"]?: "reject" | "reset";
}

export interface CharacterStateField {
	pointer: string;
	schema: CharacterStateDefinition;
	scope: StateScope;
	modelReadable: boolean;
	writeAuthority: StateAuthority;
	deterministicAuthorities: Array<"host_event" | "user_choice">;
	evidenceRequired: boolean;
	maxChangePerTurn?: number;
	allowedTransitions?: Array<[JsonValue, JsonValue]>;
	userEditable: boolean;
	hidden: boolean;
}

export interface CompiledCharacterStateSchema {
	definition: CharacterStateDefinition;
	fields: ReadonlyMap<string, CharacterStateField>;
	validate: ValidateFunction;
}

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
const compiledCache = new WeakMap<object, CompiledCharacterStateSchema>();
const AUTHORITY = /^(?:model|host_event|user_choice|user|readonly|skill:[a-z][a-z0-9-]{0,63})$/u;

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
	walk(definition, definition, "", {}, fields, 0);
	const result = { definition, fields, validate: ajv.compile(definition as AnySchema) };
	compiledCache.set(definition, result);
	return result;
}

function createAjv() {
	const instance = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
	addFormats(instance);
	for (const keyword of [
		"x-scope",
		"x-model-readable",
		"x-write-authority",
		"x-deterministic-authorities",
		"x-evidence-required",
		"x-update-when",
		"x-do-not-update-when",
		"x-max-change-per-turn",
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

export function stateFieldForPointer(
	definition: CharacterStateDefinition,
	pointer: string,
): CharacterStateField | undefined {
	const fields = compileCharacterStateSchema(definition).fields;
	let candidate = pointer;
	while (candidate) {
		const field = fields.get(candidate);
		if (field) return field;
		candidate = candidate.replace(/\/[^/]+$/u, "");
	}
	return undefined;
}

export const CharacterStateOperation = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("add"), path: z.string().min(1).max(512), value: z.unknown() }),
	z.strictObject({
		op: z.literal("replace"),
		path: z.string().min(1).max(512),
		value: z.unknown(),
	}),
	z.strictObject({ op: z.literal("remove"), path: z.string().min(1).max(512) }),
	z.strictObject({ op: z.literal("test"), path: z.string().min(1).max(512), value: z.unknown() }),
]);
export type CharacterStateOperation = z.infer<typeof CharacterStateOperation>;

export const CharacterStateEvidence = z.strictObject({
	source: z.enum(["current_user", "current_assistant", "user_choice"]),
	quote: z.string().min(1).max(2000),
});
export type CharacterStateEvidence = z.infer<typeof CharacterStateEvidence>;

interface Metadata {
	scope?: StateScope;
	modelReadable?: boolean;
	writeAuthority?: StateAuthority;
	deterministicAuthorities?: Array<"host_event" | "user_choice">;
	evidenceRequired?: boolean;
	userEditable?: boolean;
	hidden?: boolean;
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
	const metadata = inherit(inherited, current);
	if (current.type === "object" || current.properties) {
		for (const [name, child] of Object.entries(current.properties ?? {}))
			walk(root, child, `${pointer}/${escapePointer(name)}`, metadata, fields, depth + 1);
		return;
	}
	if (!pointer) return;
	if (!metadata.scope) throw new Error(`state field ${pointer} has no x-scope`);
	const writeAuthority = current.readOnly ? "readonly" : (metadata.writeAuthority ?? "readonly");
	if (!AUTHORITY.test(writeAuthority))
		throw new Error(`state field ${pointer} has invalid x-write-authority`);
	const userEditable = metadata.userEditable ?? false;
	if (userEditable && writeAuthority !== "user")
		throw new Error(`state field ${pointer} is editable but not user-authorized`);
	fields.set(pointer, {
		pointer,
		schema: current,
		scope: metadata.scope,
		modelReadable: metadata.modelReadable ?? true,
		writeAuthority,
		deterministicAuthorities: metadata.deterministicAuthorities ?? [],
		evidenceRequired: metadata.evidenceRequired ?? false,
		...(typeof current["x-max-change-per-turn"] === "number"
			? { maxChangePerTurn: current["x-max-change-per-turn"] }
			: {}),
		...(current["x-allowed-transitions"]
			? { allowedTransitions: current["x-allowed-transitions"] }
			: {}),
		userEditable,
		hidden: metadata.hidden ?? false,
	});
}

function inherit(parent: Metadata, node: CharacterStateDefinition): Metadata {
	return {
		...parent,
		...(node["x-scope"] ? { scope: node["x-scope"] } : {}),
		...(typeof node["x-model-readable"] === "boolean"
			? { modelReadable: node["x-model-readable"] }
			: {}),
		...(node["x-write-authority"] ? { writeAuthority: node["x-write-authority"] } : {}),
		...(node["x-deterministic-authorities"]
			? { deterministicAuthorities: node["x-deterministic-authorities"] }
			: {}),
		...(typeof node["x-evidence-required"] === "boolean"
			? { evidenceRequired: node["x-evidence-required"] }
			: {}),
		...(typeof node["x-user-editable"] === "boolean"
			? { userEditable: node["x-user-editable"] }
			: {}),
		...(typeof node["x-hidden"] === "boolean" ? { hidden: node["x-hidden"] } : {}),
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
