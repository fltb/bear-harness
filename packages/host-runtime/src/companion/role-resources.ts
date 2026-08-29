/** Host-owned role resource loading for the embedded Core runtime. */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "@bear-harness/schema";
import { parse } from "yaml";

const StateValue = z.union([z.string(), z.number().finite(), z.boolean()]);
const RoleSkillMetadata = z.strictObject({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z][a-z0-9-]{0,63}$/u),
	description: z.string().min(1).max(2000),
	triggers: z.strictObject({
		include: z.array(z.string().min(1).max(1000)).min(1).max(30),
		exclude: z.array(z.string().min(1).max(1000)).min(1).max(30),
	}),
	requires: z
		.strictObject({
			state: z.record(z.string().min(1).max(160), z.array(StateValue).min(1).max(30)).default({}),
		})
		.default({ state: {} }),
	"allowed-tools": z.array(z.string().min(1).max(64)).min(1).max(20),
	completion: z
		.strictObject({ state: z.record(z.string().min(1).max(160), StateValue).default({}) })
		.default({ state: {} }),
	priority: z.number().int().min(-1000).max(1000),
});

export interface RoleSkill {
	name: string;
	description: string;
	triggers: { include: string[]; exclude: string[] };
	requires: { state: Record<string, Array<string | number | boolean>> };
	allowedTools: string[];
	completion: { state: Record<string, string | number | boolean> };
	priority: number;
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
			const metadata = RoleSkillMetadata.parse(frontMatter(content));
			return {
				name: metadata.name,
				description: metadata.description,
				triggers: metadata.triggers,
				requires: metadata.requires,
				allowedTools: metadata["allowed-tools"],
				completion: metadata.completion,
				priority: metadata.priority,
				content,
				filePath,
			};
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
				`<skill id="${escapeXml(skill.name)}" priority="${skill.priority}">${escapeXml(skill.description)}</skill>`,
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

function frontMatter(content: string): unknown {
	const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(content);
	const parsed = match?.[1] ? parse(match[1]) : undefined;
	return parsed ?? {};
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}
