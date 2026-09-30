// @vitest-environment node
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import {
	eligibleRoleSkillResources,
	loadRoleSkills,
	readRoleSkillResource,
	roleSkillStatus,
} from "../src/companion/role-resources.js";

const packageRoot = resolve(import.meta.dirname, "../../../config/characters/jizhou");

describe("independent Jizhou reference and Skills", () => {
	it("loads each Skill by itself without Canon, character state or media", () => {
		for (const name of ["read-together", "umbrella-shop"]) {
			const root = mkdtempSync(join(tmpdir(), "bear-independent-skill-"));
			try {
				cpSync(join(packageRoot, "skills", name), root, { recursive: true });
				const [skill] = loadRoleSkills([root]);
				if (!skill) throw new Error("missing Skill");
				expect(roleSkillStatus(skill, {})).toBe("eligible");
				expect(eligibleRoleSkillResources(skill, {})).toHaveLength(skill.resources.length);
				for (const resource of skill.resources) {
					expect(readRoleSkillResource(skill, resource)).toContain("故事资料");
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("loads reference documents without Skills and without the retired chapter counter", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-independent-canon-"));
		try {
			cpSync(packageRoot, join(root, "jizhou"), { recursive: true });
			rmSync(join(root, "jizhou", "skills"), { recursive: true });
			const character = new CharacterLoader(root).load("jizhou");
			expect(character?.canon.sources).toHaveLength(3);
			expect(character?.skills).toEqual([]);
			expect(JSON.stringify(character?.state)).not.toContain('"chapter"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
