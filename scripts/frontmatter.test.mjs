import assert from "node:assert/strict";
import test from "node:test";
import { parseYamlFrontmatter } from "./frontmatter.mjs";

test("YAML frontmatter retains scalar types with LF and CRLF line endings", () => {
	const source = "---\nname: example\npriority: 50\n---\nBody\n";
	assert.deepEqual(parseYamlFrontmatter(source), { name: "example", priority: 50 });
	assert.deepEqual(parseYamlFrontmatter(source.split("\n").join("\r\n")), {
		name: "example",
		priority: 50,
	});
});

test("YAML frontmatter rejects absent and unfinished boundaries", () => {
	assert.equal(parseYamlFrontmatter("name: example\n"), undefined);
	assert.equal(parseYamlFrontmatter("---\nname: example\n"), undefined);
});
