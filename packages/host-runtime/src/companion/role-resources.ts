/** Host-owned role resource loading for the embedded Core runtime. */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

export interface RoleSkill {
	name: string;
	description: string;
	content: string;
	filePath: string;
}

export interface RolePluginApi {
	registerTool(tool: unknown): void;
}

export function loadRoleSkills(skillRoots: readonly string[]): RoleSkill[] {
	return skillRoots
		.flatMap((root) => files(root, (path) => path.endsWith("SKILL.md")))
		.sort((left, right) => left.localeCompare(right))
		.map((filePath) => {
			const content = readFileSync(filePath, "utf8");
			const metadata = frontMatter(content);
			if (!metadata.name || !metadata.description) {
				throw new Error(`role Skill ${filePath} requires frontmatter name and description`);
			}
			return { name: metadata.name, description: metadata.description, content, filePath };
		});
}

export async function loadRolePluginTools(pluginPaths: readonly string[]): Promise<unknown[]> {
	const tools: unknown[] = [];
	const api: RolePluginApi = { registerTool: (tool) => tools.push(tool) };
	for (const path of pluginPaths) {
		const module = await import(pathToFileURL(path).href);
		if (typeof module.default !== "function") {
			throw new Error(`role plugin ${path} must export a default registration function`);
		}
		await module.default(api);
	}
	return tools;
}

export function roleSkillPrompt(skills: readonly RoleSkill[]): string {
	if (skills.length === 0) return "";
	return `<role_skills>\n${skills
		.map(
			(skill) =>
				`<skill name="${escapeXml(skill.name)}" path="${escapeXml(skill.filePath)}">${escapeXml(skill.description)}</skill>`,
		)
		.join("\n")}\n</role_skills>`;
}

function files(root: string, predicate: (path: string) => boolean): string[] {
	const collected: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (lstatSync(path).isDirectory()) visit(path);
			else if (lstatSync(path).isFile() && predicate(path)) collected.push(path);
		}
	};
	visit(root);
	return collected;
}

function frontMatter(content: string): { name?: string; description?: string } {
	const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(content);
	const parsed = match?.[1] ? parse(match[1]) : undefined;
	if (!parsed || typeof parsed !== "object") return {};
	const value = parsed as Record<string, unknown>;
	return {
		name: typeof value.name === "string" ? value.name : undefined,
		description: typeof value.description === "string" ? value.description : undefined,
	};
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}
