import { z } from "@bear-harness/schema";
import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import jsonPatch from "fast-json-patch";
export type StateScope = "conversation" | "global";
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export interface CharacterStateDefinition extends Record<string, unknown> {
	readonly fields: Record<string, true>;
	type?: string | string[];
	default?: JsonValue;
	properties?: Record<string, CharacterStateDefinition>;
	additionalProperties?: boolean | CharacterStateDefinition;
	"x-scope"?: StateScope;
	"x-incompatible-state"?: "reject" | "reset";
}
type CompiledSchema = {
	partitions: ReadonlyMap<string, StateScope>;
	fields: ReadonlySet<string>;
	defaults: JsonObject;
	validate: ValidateFunction;
};
const Ajv2020 = Ajv2020Module.default;
const ajv = new Ajv2020({ strict: false, addUsedSchema: false });
const cache = new WeakMap<object, CompiledSchema>();
export const CharacterStateSchema = {
	parse(input: unknown): CharacterStateDefinition {
		if (!record(input)) throw new Error("state_schema must be an object");
		const definition = input as CharacterStateDefinition;
		const fields = Object.fromEntries(
			[...compileCharacterStateSchema(definition).fields].map((path) => [path, true]),
		);
		Object.defineProperty(definition, "fields", { value: fields, enumerable: false });
		return definition;
	},
};
export function compileCharacterStateSchema(definition: CharacterStateDefinition): CompiledSchema {
	const cached = cache.get(definition);
	if (cached) return cached;
	if (definition.$schema !== "https://json-schema.org/draft/2020-12/schema")
		throw new Error("state_schema must declare JSON Schema Draft 2020-12");
	if (definition.type !== "object") throw new Error("state_schema root must be an object");
	if (definition.additionalProperties !== false)
		throw new Error("state_schema root must reject additional properties");
	if (Object.hasOwn(definition, "x-scope"))
		throw new Error("state_schema root may not declare x-scope");
	const properties = definition.properties ?? {};
	inspect(definition, new Set(Object.values(properties)));
	const fields = new Set<string>();
	const partitions = new Map<string, StateScope>();
	const defaults: JsonObject = {};
	for (const [name, child] of Object.entries(properties)) {
		const pointer = `/${pointerEscape(name)}`;
		const scope = child["x-scope"];
		if (scope !== "global" && scope !== "conversation")
			throw new Error(`state partition ${pointer} x-scope must be global or conversation`);
		if (child.type !== "object" && !child.properties)
			throw new Error(`state partition ${pointer} must be an object`);
		partitions.set(name, scope);
		defaults[name] = visit(fields, child, pointer);
	}
	const compiled = { partitions, fields, defaults, validate: ajv.compile(definition) };
	cache.set(definition, compiled);
	return compiled;
}

export function characterStatePrompt(definition: CharacterStateDefinition): string {
	const lines: string[] = [];
	const walk = (node: CharacterStateDefinition, path: string): void => {
		if (node.type === "object" || node.properties) {
			for (const [name, child] of Object.entries(node.properties ?? {}))
				walk(child, `${path}/${pointerEscape(name)}`);
			return;
		}
		if (node["x-model-readable"] === false) return;
		const type = Array.isArray(node.type) ? node.type.join(" | ") : node.type;
		const title = typeof node.title === "string" ? node.title : path;
		const description = typeof node.description === "string" ? node.description.trim() : "";
		const bounds = [
			type ? `类型：${type}` : "",
			type === "number" && typeof node.minimum === "number" ? `最小值：${node.minimum}` : "",
			type === "number" && typeof node.maximum === "number" ? `最大值：${node.maximum}` : "",
		]
			.filter(Boolean)
			.join("；");
		const choices = Array.isArray(node.enum)
			? `可选值：${node.enum.map(String).join("、")}`
			: Array.isArray(node.oneOf)
				? `可选值：${node.oneOf
						.map((item) => (record(item) ? item.const : undefined))
						.filter((value) => value !== undefined)
						.map(String)
						.join("、")}`
				: "";
		lines.push(
			[`路径：/character${path}`, `名称：${title}`, bounds, choices, description]
				.filter(Boolean)
				.join("\n"),
		);
	};
	walk(definition, "");
	return `<character_state_contract>\n${lines.join("\n\n")}\n</character_state_contract>`;
}
const PatchPath = z.string().min(1).max(512);
export const CharacterStateChange = z.strictObject({ path: PatchPath, value: z.unknown() });
export type CharacterStateChange = z.infer<typeof CharacterStateChange>;
export function applyCharacterStateChanges(input: {
	definition: CharacterStateDefinition;
	document: JsonObject;
	changes: CharacterStateChange[];
	prefix?: string;
}): JsonObject {
	const compiled = compileCharacterStateSchema(input.definition);
	const next = structuredClone(input.document);
	for (const item of input.changes) {
		const parsed = CharacterStateChange.parse(item);
		const path = parsed.path.slice(input.prefix?.length ?? 0);
		if (!compiled.fields.has(path))
			throw { kind: "validation_failed", reason: "character_state_path_invalid" };
		jsonPatch.applyPatch(next, [{ op: "replace", path, value: parsed.value }], true, true);
	}
	if (!compiled.validate(next))
		throw { kind: "validation_failed", reason: "character_state_invalid" };
	return next;
}
function visit(fields: Set<string>, node: CharacterStateDefinition, pointer: string): JsonValue {
	if (node.type === "object" || node.properties) {
		const defaults: JsonObject = {};
		for (const [name, child] of Object.entries(node.properties ?? {})) {
			const path = `${pointer}/${pointerEscape(name)}`;
			defaults[name] = visit(fields, child, path);
		}
		return defaults;
	}
	fields.add(pointer);
	if (node.default === undefined) throw new Error(`state field ${pointer} must declare a default`);
	return structuredClone(node.default) as JsonValue;
}
function inspect(value: unknown, scoped: ReadonlySet<object>): void {
	if (!value || typeof value !== "object") return;
	if (record(value) && Object.hasOwn(value, "x-scope") && !scoped.has(value))
		throw new Error("state field may not override its partition x-scope");
	for (const child of Object.values(value)) inspect(child, scoped);
}
const pointerEscape = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const record = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));
