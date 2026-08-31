// @vitest-environment node

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	eligibleRoleSkillResources,
	loadRoleSkills,
	readRoleSkillResource,
	roleSkillStatus,
} from "../src/companion/role-resources.js";

const skills = loadRoleSkills([
	resolve(import.meta.dirname, "../../../config/characters/jizhou/skills"),
]);
const story = skills.find((skill) => skill.name === "undelivered-report");
if (!story) throw new Error("missing undelivered-report Skill");

const state = (active: boolean, chapter: number) => ({ story: { active, chapter } });

describe("state-gated role Skill resources", () => {
	it("derives Skill activity from package metadata without role-name branches", () => {
		expect(roleSkillStatus(story, state(false, 0))).toBe("eligible");
		expect(roleSkillStatus(story, state(true, 1))).toBe("active");
	});

	it("exposes only resources allowed by the authoritative story position", () => {
		const entryResources = eligibleRoleSkillResources(story, state(false, 0));
		expect(entryResources.map((resource) => resource.id)).toEqual(["entry"]);
		const entry = entryResources[0];
		if (!entry) throw new Error("entry resource is required");
		const entryText = readRoleSkillResource(story, entry);
		expect(entryText).toContain("## 序章：留言簿里的断行");
		expect(entryText).not.toContain("## 第四章：最后一班");

		const lastShiftResources = eligibleRoleSkillResources(story, state(true, 4));
		expect(lastShiftResources.map((resource) => resource.id)).toEqual(["last-shift"]);
		const lastShift = lastShiftResources[0];
		if (!lastShift) throw new Error("last-shift resource is required");
		expect(readRoleSkillResource(story, lastShift)).toContain("## 第四章：最后一班");
	});

	it("uses simple scalars and natural-language summaries instead of an enum state machine", () => {
		expect(story.content).toContain("`host_state.update` 的 `changes`");
		expect(story.content).toContain("`summary`");
		expect(story.content).toContain("`current_situation`");
		expect(story.content).toContain("`host_choices`");
		expect(story.content).not.toContain("branch=none");
		expect(story.content).not.toContain("evidence_mode=inferred");
	});
});
