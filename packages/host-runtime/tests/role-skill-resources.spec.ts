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

function state(status: string, position: string) {
	return {
		story: {
			undelivered_report: {
				phase: "invited",
				status,
				position,
			},
		},
	};
}

describe("state-gated role Skill resources", () => {
	it("derives Skill activity from package metadata without role-name branches", () => {
		expect(roleSkillStatus(story, state("inactive", "entry"))).toBe("eligible");
		expect(roleSkillStatus(story, state("active", "entry"))).toBe("active");
	});

	it("exposes only resources allowed by the authoritative story position", () => {
		const entryResources = eligibleRoleSkillResources(story, state("active", "entry"));
		expect(entryResources.map((resource) => resource.id)).toEqual(["entry", "damaged-signal"]);
		const entryText = readRoleSkillResource(story, entryResources[0]!);
		expect(entryText).toContain("## 序章：留言簿里的断行");
		expect(entryText).not.toContain("## 第四章：最后一班");

		const lastShiftResources = eligibleRoleSkillResources(story, state("active", "last_shift"));
		expect(lastShiftResources.map((resource) => resource.id)).toEqual(["last-shift"]);
		expect(readRoleSkillResource(story, lastShiftResources[0]!)).toContain("## 第四章：最后一班");
	});
});
