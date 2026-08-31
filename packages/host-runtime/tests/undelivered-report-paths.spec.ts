// @vitest-environment node

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import {
	eligibleRoleSkillResources,
	loadRoleSkills,
	roleSkillStatus,
} from "../src/companion/role-resources.js";

const characterRoot = resolve(process.cwd(), "../../config/characters");

describe("《未送达的回报》natural-language path contract", () => {
	it("keeps choices out of the package and delegates response-specific choices to the tool", () => {
		const character = new CharacterLoader(characterRoot).load("jizhou");
		expect(character).not.toBeNull();
		if (!character) return;
		expect(character).not.toHaveProperty("roleplay");
		expect(character).not.toHaveProperty("choice_sets");
		const [skill] = loadRoleSkills([resolve(characterRoot, "jizhou/skills/undelivered-report")]);
		expect(skill?.content).toContain("`host_choices`");
	});

	it("selects one chapter resource from a simple number", () => {
		const [skill] = loadRoleSkills([resolve(characterRoot, "jizhou/skills/undelivered-report")]);
		if (!skill) throw new Error("undelivered-report skill missing");
		const eligibleAt = (chapter: number) =>
			eligibleRoleSkillResources(skill, {
				story: { chapter },
			}).map((resource) => resource.id);

		expect(eligibleAt(0)).toEqual(["entry"]);
		expect(eligibleAt(1)).toEqual(["damaged-signal"]);
		expect(eligibleAt(2)).toEqual(["routes"]);
		expect(eligibleAt(4)).toEqual(["last-shift"]);
		expect(eligibleAt(7)).toEqual(["ending"]);
	});

	it("uses a single boolean for active versus resumable", () => {
		const [skill] = loadRoleSkills([resolve(characterRoot, "jizhou/skills/undelivered-report")]);
		if (!skill) throw new Error("undelivered-report skill missing");
		expect(
			roleSkillStatus(skill, {
				story: { active: false, chapter: 7 },
			}),
		).toBe("eligible");
		expect(
			roleSkillStatus(skill, {
				story: { active: true, chapter: 7 },
			}),
		).toBe("active");
	});
});
