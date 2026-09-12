import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readPersona, writePersona } from "../src/lib/persona-editor.js";

const source = `# package comment
behavior:
  identity:
    summary: Original identity
    invariants: [Be honest]
    knowledge_boundaries: [Do not invent]
  agency:
    never: [Speak for the user]
    when_uncertain: [Ask]
  interaction: Direct
  examples:
    - user: Hello
      assistant: Hi
system_prompt: Independent instructions
scenes: [{id: snow}]
state_schema: {type: object}
`;

describe("persona package editing", () => {
	it("reads authoritative identity and preserves unrelated fields and comments", () => {
		const draft = readPersona(source);
		expect(draft.fields.summary).toBe("Original identity");
		draft.fields.summary = "Edited identity";
		draft.fields.never = "Do not impersonate\nDo not invent";
		draft.examples = [{ user: "Question", assistant: "Answer" }];
		const output = writePersona(source, draft);
		const original = parse(source);
		const next = parse(output);
		expect(next.behavior.identity.summary).toBe("Edited identity");
		expect(next.behavior.agency.never).toEqual(["Do not impersonate", "Do not invent"]);
		expect(next.behavior.examples).toEqual(draft.examples);
		expect(next.system_prompt).toEqual(original.system_prompt);
		expect(next.scenes).toEqual(original.scenes);
		expect(next.state_schema).toEqual(original.state_schema);
		expect(output).toContain("# package comment");
	});
	it("does not synthesize behavior when saving unrelated prompt edits", () => {
		const input = "system_prompt: Hello\n";
		expect(parse(writePersona(input, readPersona(input)))).toEqual(parse(input));
	});
	it("rejects malformed source instead of silently rewriting it", () => {
		expect(() => writePersona("behavior: [", readPersona(source))).toThrow();
	});
});
