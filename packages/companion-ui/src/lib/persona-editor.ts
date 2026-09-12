import { isNode, parseDocument } from "yaml";

export const PERSONA_FIELDS = {
	summary: ["behavior", "identity", "summary"],
	invariants: ["behavior", "identity", "invariants"],
	knowledge: ["behavior", "identity", "knowledge_boundaries"],
	never: ["behavior", "agency", "never"],
	uncertain: ["behavior", "agency", "when_uncertain"],
	interaction: ["behavior", "interaction"],
} as const;
export type PersonaField = keyof typeof PERSONA_FIELDS;
export const PERSONA_KEYS = Object.keys(PERSONA_FIELDS) as PersonaField[];
export const isPersonaList = (field: PersonaField) =>
	field !== "summary" && field !== "interaction";
export type PersonaDraft = {
	fields: Record<PersonaField, string>;
	examples: Array<{ user: string; assistant: string }>;
};

export function readPersona(source: string): PersonaDraft {
	const yaml = parseDocument(source);
	const fields = Object.fromEntries(
		PERSONA_KEYS.map((field) => {
			const node = yaml.getIn([...PERSONA_FIELDS[field]], true);
			const value = isNode(node) ? node.toJSON() : undefined;
			return [
				field,
				Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "",
			];
		}),
	) as PersonaDraft["fields"];
	const node = yaml.getIn(["behavior", "examples"], true);
	const examples = isNode(node) ? node.toJSON() : undefined;
	return { fields, examples: Array.isArray(examples) ? examples : [] };
}

/** Patch only edited paths, preserving the original identity and unrelated package data. */
export function writePersona(source: string, draft: PersonaDraft): string {
	const yaml = parseDocument(source);
	if (yaml.errors.length) throw new Error(yaml.errors[0]?.message);
	const previous = readPersona(source);
	for (const field of PERSONA_KEYS) {
		if (draft.fields[field] === previous.fields[field]) continue;
		const value = isPersonaList(field)
			? draft.fields[field]
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
			: draft.fields[field];
		yaml.setIn([...PERSONA_FIELDS[field]], value);
	}
	if (JSON.stringify(draft.examples) !== JSON.stringify(previous.examples)) {
		yaml.setIn(["behavior", "examples"], draft.examples);
	}
	return String(yaml);
}
