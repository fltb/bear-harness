/** Host-owned role resource loading for the embedded Core runtime. */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "@bear-harness/schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import jsonPatch from "fast-json-patch";
import { parse } from "yaml";

const MAX_ROLE_RESOURCE_TREE_DEPTH = 64;
const MAX_ROLE_RESOURCE_TREE_ENTRIES = 10_000;

const StateValue = z.union([z.string(), z.number().finite(), z.boolean()]);
const { getValueByPointer } = jsonPatch;
const StateRules = z.record(z.string().min(1).max(160), z.array(StateValue).min(1).max(30));
const RoleSkillResourceMetadata = z.strictObject({
	id: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z][a-z0-9-]{0,63}$/u),
	path: z
		.string()
		.min(1)
		.max(240)
		.regex(/^[^/\\].*\.md$/u),
	headings: z.array(z.string().min(1).max(240)).min(1).max(30),
	when: z.strictObject({ state: StateRules.default({}) }).default({ state: {} }),
});
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
			state: StateRules.default({}),
		})
		.default({ state: {} }),
	"active-when": z.strictObject({ state: StateRules.default({}) }).default({ state: {} }),
	resources: z.array(RoleSkillResourceMetadata).max(100).default([]),
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
	activeWhen: { state: Record<string, Array<string | number | boolean>> };
	resources: RoleSkillResource[];
	allowedTools: string[];
	completion: { state: Record<string, string | number | boolean> };
	priority: number;
	content: string;
	filePath: string;
}

export interface RoleSkillResource {
	id: string;
	path: string;
	headings: string[];
	when: { state: Record<string, Array<string | number | boolean>> };
}

export type RoleSkillStatus = "blocked" | "eligible" | "active" | "completed";

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
				activeWhen: metadata["active-when"],
				resources: metadata.resources,
				allowedTools: metadata["allowed-tools"],
				completion: metadata.completion,
				priority: metadata.priority,
				content,
				filePath,
			};
		});
}

export function roleSkillStatus(skill: RoleSkill, state: object): RoleSkillStatus {
	if (
		Object.keys(skill.completion.state).length > 0 &&
		matchesExpectedState(state, skill.completion.state)
	)
		return "completed";
	if (!matchesAllowedState(state, skill.requires.state)) return "blocked";
	if (
		Object.keys(skill.activeWhen.state).length > 0 &&
		matchesAllowedState(state, skill.activeWhen.state)
	)
		return "active";
	return "eligible";
}

export function eligibleRoleSkillResources(skill: RoleSkill, state: object): RoleSkillResource[] {
	return skill.resources.filter((resource) => matchesAllowedState(state, resource.when.state));
}

export function readRoleSkillResource(skill: RoleSkill, resource: RoleSkillResource): string {
	const skillDirectory = dirname(skill.filePath);
	const resourcePath = resolve(skillDirectory, resource.path);
	const rel = relative(skillDirectory, resourcePath);
	if (!rel || rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\"))
		throw new Error(`role Skill resource ${resource.id} escapes its Skill directory`);
	const source = readFileSync(resourcePath, "utf8");
	return extractMarkdownHeadings(source, resource.headings);
}

export async function loadRolePluginTools(pluginPaths: readonly string[]): Promise<AgentTool[]> {
	const tools: AgentTool[] = [];
	const names = new Set<string>();
	const api: RolePluginApi = {
		registerTool: (candidate) => {
			if (!isAgentTool(candidate)) throw new Error("role plugin registered an invalid tool");
			if (names.has(candidate.name)) {
				throw new Error(`role plugin registered duplicate tool: ${candidate.name}`);
			}
			names.add(candidate.name);
			tools.push(candidate);
		},
	};
	for (const path of pluginPaths) {
		const module = await import(pathToFileURL(path).href);
		if (typeof module.default !== "function") {
			throw new Error(`role plugin ${path} must export a default registration function`);
		}
		await module.default(api);
	}
	return tools;
}

function isAgentTool(candidate: unknown): candidate is AgentTool {
	if (!candidate || typeof candidate !== "object") return false;
	const tool = candidate as Record<string, unknown>;
	return (
		typeof tool.name === "string" &&
		tool.name.length > 0 &&
		typeof tool.label === "string" &&
		typeof tool.description === "string" &&
		typeof tool.parameters === "object" &&
		tool.parameters !== null &&
		typeof tool.execute === "function"
	);
}

export function roleSkillPrompt(skills: readonly RoleSkill[]): string {
	if (skills.length === 0) return "";
	return `<role_skills>\n${skills
		.map(
			(skill) =>
				`<skill id="${escapeXml(skill.name)}" priority="${skill.priority}"><description>${escapeXml(skill.description)}</description><include>${escapeXml(JSON.stringify(skill.triggers.include))}</include><exclude>${escapeXml(JSON.stringify(skill.triggers.exclude))}</exclude></skill>`,
		)
		.join("\n")}\n</role_skills>`;
}

function files(root: string, predicate: (path: string) => boolean): string[] {
	const collected: string[] = [];
	const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
	let entriesSeen = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		if (current.depth > MAX_ROLE_RESOURCE_TREE_DEPTH)
			throw new Error("role resource tree is too deep");
		for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
			entriesSeen += 1;
			if (entriesSeen > MAX_ROLE_RESOURCE_TREE_ENTRIES)
				throw new Error("role resource tree is too large");
			const path = join(current.directory, entry.name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) pending.push({ directory: path, depth: current.depth + 1 });
			else if (stat.isFile() && predicate(path)) collected.push(path);
		}
	}
	return collected;
}

function frontMatter(content: string): unknown {
	const lines = content.split("\r\n").join("\n").split("\r").join("\n").split("\n");
	if (lines[0]?.trim() !== "---") return {};
	const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (closingIndex < 0) return {};
	const source = lines.slice(1, closingIndex).join("\n");
	const parsed = source.length > 0 ? parse(source) : undefined;
	return parsed ?? {};
}

function matchesAllowedState(
	state: object,
	rules: Record<string, Array<string | number | boolean>>,
): boolean {
	return Object.entries(rules).every(([pointer, allowed]) =>
		allowed.some((value) => Object.is(value, getValueByPointer(state, pointer))),
	);
}

function matchesExpectedState(
	state: object,
	rules: Record<string, string | number | boolean>,
): boolean {
	return Object.entries(rules).every(([pointer, expected]) =>
		Object.is(expected, getValueByPointer(state, pointer)),
	);
}

function extractMarkdownHeadings(source: string, requested: readonly string[]): string {
	const sections = new Map<string, string>();
	const lines = source.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(lines[index] ?? "");
		if (!match?.[1] || !match[2]) continue;
		const level = match[1].length;
		let end = index + 1;
		while (end < lines.length) {
			const next = /^(#{1,6})\s+/u.exec(lines[end] ?? "");
			if (next?.[1] && next[1].length <= level) break;
			end += 1;
		}
		sections.set(match[2], lines.slice(index, end).join("\n").trim());
	}
	return requested
		.map((heading) => {
			const section = sections.get(heading);
			if (!section) throw new Error(`role Skill resource heading not found: ${heading}`);
			return section;
		})
		.join("\n\n");
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}
