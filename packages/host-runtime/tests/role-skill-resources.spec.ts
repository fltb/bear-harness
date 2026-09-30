// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	eligibleRoleSkillResources,
	loadRolePluginTools,
	loadRoleSkills,
	readRoleSkillResource,
	roleSkillStatus,
} from "../src/companion/role-resources.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function gatedSkill() {
	const directory = mkdtempSync(join(tmpdir(), "bear-gated-resource-"));
	temporaryDirectories.push(directory);
	writeFileSync(
		join(directory, "SKILL.md"),
		`---
name: test-resource
description: Read one test section.
triggers: { include: [Read test], exclude: [Other request] }
requires: { state: { /available: [true] } }
active-when: { state: { /reading: [true] } }
completion: { state: { /done: true } }
resources:
  - { id: first, path: text.md, headings: [First], when: { state: { /position: [0] } } }
  - { id: second, path: text.md, headings: [Second], when: { state: { /position: [1] } } }
allowed-tools: [host_choices]
priority: 0
---
Read a section.
`,
	);
	writeFileSync(join(directory, "text.md"), "# Text\n\n## First\nOne\n\n## Second\nTwo\n");
	const skill = loadRoleSkills([directory])[0];
	if (!skill) throw new Error("missing test Skill");
	return skill;
}

describe("state-gated role Skill resources", () => {
	it("loads numeric metadata from Windows CRLF frontmatter", () => {
		const directory = mkdtempSync(join(tmpdir(), "bear-role-skill-crlf-"));
		temporaryDirectories.push(directory);
		const source = [
			"---",
			"name: numeric-metadata",
			"description: Read a bounded test resource.",
			"triggers: { include: [Read this resource], exclude: [Unrelated request] }",
			"allowed-tools: [host_state]",
			"priority: 50",
			"---",
			"Read the supplied resource.",
		].join("\n");
		writeFileSync(join(directory, "SKILL.md"), source.split("\n").join("\r\n"));

		expect(loadRoleSkills([directory])).toMatchObject([{ name: "numeric-metadata", priority: 50 }]);
	});

	it("loads a Skill beyond the former directory-depth quota", () => {
		const directory = mkdtempSync(join(tmpdir(), "bear-role-skill-depth-"));
		temporaryDirectories.push(directory);
		let nested = directory;
		for (let depth = 0; depth < 66; depth += 1) {
			nested = join(nested, "d");
			mkdirSync(nested);
		}

		writeFileSync(
			join(nested, "SKILL.md"),
			"---\nname: nested-skill\ndescription: A deeply nested Skill.\ntriggers: { include: [Read this resource], exclude: [Unrelated request] }\nallowed-tools: [host_state]\npriority: 50\n---\nRead the supplied resource.\n",
		);
		expect(loadRoleSkills([directory])).toMatchObject([{ name: "nested-skill" }]);
	});

	it("derives eligibility, activity and completion from independent metadata", () => {
		const skill = gatedSkill();
		expect(roleSkillStatus(skill, {})).toBe("blocked");
		expect(roleSkillStatus(skill, { available: true })).toBe("eligible");
		expect(roleSkillStatus(skill, { available: true, reading: true })).toBe("active");
		expect(roleSkillStatus(skill, { available: true, done: true })).toBe("completed");
	});

	it("selects and reads only the section allowed by metadata", () => {
		const skill = gatedSkill();
		for (const [position, id, included, excluded] of [
			[0, "first", "One", "Two"],
			[1, "second", "Two", "One"],
		] as const) {
			const resources = eligibleRoleSkillResources(skill, { position });
			expect(resources.map((resource) => resource.id)).toEqual([id]);
			const resource = resources[0];
			if (!resource) throw new Error("missing resource");
			const text = readRoleSkillResource(skill, resource);
			expect(text).toContain(included);
			expect(text).not.toContain(excluded);
		}
		expect(eligibleRoleSkillResources(skill, { position: 2 })).toEqual([]);
	});
});

describe("role Plugin tools", () => {
	it("loads tools registered by an existing role Plugin", async () => {
		const directory = mkdtempSync(join(tmpdir(), "bear-role-plugin-"));
		temporaryDirectories.push(directory);
		const pluginPath = join(directory, "plugin.mjs");
		writeFileSync(
			pluginPath,
			`export default function register(api) {
  api.registerTool({
    name: "station_status",
    label: "Station status",
    description: "Read station status",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ready" }], details: {} }; }
  });
}\n`,
		);

		await expect(loadRolePluginTools([pluginPath])).resolves.toMatchObject([
			{ name: "station_status" },
		]);
	});
});
