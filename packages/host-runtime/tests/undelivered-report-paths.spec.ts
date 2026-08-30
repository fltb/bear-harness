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
	it("exposes every story branch as ordinary user text with no executable choice metadata", () => {
		const character = new CharacterLoader(characterRoot).load("jizhou");
		expect(character).not.toBeNull();
		if (!character) return;
		const sets = character.roleplay.choice_sets.filter((set) => set.id.startsWith("undelivered_"));
		expect(sets.map((set) => set.id)).toEqual([
			"undelivered_entry",
			"undelivered_signal",
			"undelivered_route",
			"undelivered_testimony",
			"undelivered_last_shift",
			"undelivered_future",
			"undelivered_ending",
			"undelivered_archived_resume",
			"undelivered_reopened_ending",
		]);
		const choices = sets.flatMap((set) => set.choices);
		expect(choices.length).toBeGreaterThanOrEqual(24);
		for (const choice of choices) {
			expect(choice.message.trim().length).toBeGreaterThan(0);
			expect(choice).not.toHaveProperty("event");
			expect(choice).not.toHaveProperty("follow_up");
		}
	});

	it("keeps all three endings and the archived reopening path available as natural language", () => {
		const character = new CharacterLoader(characterRoot).load("jizhou");
		if (!character) throw new Error("jizhou package missing");
		const byId = new Map(character.roleplay.choice_sets.map((set) => [set.id, set]));
		expect(byId.get("undelivered_ending")?.choices.map((choice) => choice.id)).toEqual([
			"returned",
			"archived",
			"left_open",
		]);
		expect(
			byId.get("undelivered_archived_resume")?.choices.find((choice) => choice.id === "reopen")
				?.message,
		).toContain("重新打开");
		expect(byId.get("undelivered_reopened_ending")?.choices.map((choice) => choice.id)).toEqual([
			"returned",
			"left_open",
			"pause",
		]);
	});

	it("makes each next chapter readable before committing its destination position", () => {
		const [skill] = loadRoleSkills([resolve(characterRoot, "jizhou/skills/undelivered-report")]);
		if (!skill) throw new Error("undelivered-report skill missing");
		const eligibleAt = (position: string) =>
			eligibleRoleSkillResources(skill, {
				story: { undelivered_report: { position } },
			}).map((resource) => resource.id);

		expect(eligibleAt("evidence")).toEqual(expect.arrayContaining(["storm-relay", "snow-route"]));
		expect(eligibleAt("snowfield_reconstruction")).toContain("testimonies");
		expect(eligibleAt("relay")).toContain("testimonies");
		expect(eligibleAt("testimony")).toContain("last-shift");
		expect(eligibleAt("last_shift")).toContain("future");
		expect(eligibleAt("future")).toContain("ending");
	});

	it("keeps an archived ending reopenable instead of marking the Skill completed", () => {
		const [skill] = loadRoleSkills([resolve(characterRoot, "jizhou/skills/undelivered-report")]);
		if (!skill) throw new Error("undelivered-report skill missing");
		expect(
			roleSkillStatus(skill, {
				story: { undelivered_report: { phase: "resolved", status: "paused" } },
			}),
		).toBe("eligible");
		expect(
			roleSkillStatus(skill, {
				story: { undelivered_report: { phase: "resolved", status: "completed" } },
			}),
		).toBe("completed");
	});
});
