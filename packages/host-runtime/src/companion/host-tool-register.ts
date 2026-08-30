import { isAbsolute } from "node:path";
import { toJsonSchema, z } from "@bear-harness/schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import jsonPatch from "fast-json-patch";
import { OfficeParser } from "officeparser";
import type { CharacterPackage } from "./character-loader.js";
import type { CompanionMutation, CompanionStateStore } from "./companion-store.js";
import {
	eligibleRoleSkillResources,
	readRoleSkillResource,
	roleSkillStatus,
} from "./role-resources.js";
import type { RoleplayCondition } from "./roleplay-schema.js";
import { CharacterStateOperation, type StateAuthority } from "./state-schema.js";

type Result = { ok: boolean; code?: string; message: string; data?: unknown };
type Input = {
	sessionId: () => string;
	entryId: () => string;
	character: () => CharacterPackage;
	store: CompanionStateStore;
	delegate(params: {
		conversationId: string;
		triggerEntryId: string;
		agent: "pi" | "codex";
		inputPaths: string[];
		instruction: string;
	}): Promise<{ runId: string; status: "enqueued" | "running" }>;
	history(query: string, limit: number): Promise<unknown>;
	canon(query: string, limit: number): Promise<unknown>;
	memory(query: string, limit: number): Promise<unknown>;
};

const DisplayArgs = z.strictObject({
	sceneId: z.string().max(64).optional().describe("Declared scene id."),
	expressionId: z.string().max(64).optional().describe("Declared expression id."),
	mediaId: z.string().max(64).optional().describe("Declared eligible media id to present."),
	choiceSetId: z
		.string()
		.max(64)
		.optional()
		.describe("Declared eligible choice-set id; each option remains ordinary user input."),
	dismissPresentationId: z
		.string()
		.max(64)
		.optional()
		.describe("Currently presented media or choice-set id to dismiss."),
});
const StateReadArgs = z.strictObject({ action: z.literal("read") });
const StateUpdateArgs = z.strictObject({
	action: z.literal("update"),
	operations: z
		.array(CharacterStateOperation)
		.max(50)
		.optional()
		.describe("RFC 6902 operations against declared Character State JSON pointers."),
	reason: z.string().max(2000).optional(),
	skillId: z
		.string()
		.max(64)
		.optional()
		.describe("Character Skill id whose declared write authority is being used."),
	evidence: z
		.unknown()
		.optional()
		.describe("Present only when the update is supported by evidence available this turn."),
	display: DisplayArgs.optional().describe(
		"Presentation changes committed atomically with this Character State update.",
	),
});
const StateArgs = z.discriminatedUnion("action", [StateReadArgs, StateUpdateArgs]);
const SkillArgs = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("list") }),
	z.strictObject({ action: z.literal("read"), skillId: z.string().min(1).max(64) }),
]);
const DocumentArgs = z.strictObject({
	path: z.string().min(1).max(4096),
	offset: z.number().int().min(0).optional(),
	limit: z.number().int().min(1).max(50_000).optional(),
});
const DelegateArgs = z.strictObject({
	agent: z.enum(["pi", "codex"]),
	instruction: z.string().min(1).max(12_000),
	inputPaths: z.array(z.string().min(1).max(4096)).max(10).default([]),
});
const SearchArgs = z.strictObject({
	query: z.string().min(1).max(2000),
	limit: z.number().int().min(1).max(20).default(8),
});

/** Register stateless product tools directly on Pi's AgentSession. */
export function registerHostTools(input: Input): Record<string, AgentTool> {
	const tool = (
		name: string,
		label: string,
		description: string,
		schema: z.ZodType,
		run: (args: any) => Result | Promise<Result>,
	) => ({
		name,
		label,
		description,
		parameters: toJsonSchema(schema) as never,
		execute: async (_id: string, args: unknown) => {
			const result = await run(schema.parse(args));
			return {
				content: [{ type: "text" as const, text: result.message }],
				details: result,
			};
		},
	});
	return {
		role_skill: tool(
			"role_skill",
			"Character skill",
			"List declared Character Skills, or read one matching the user's request. Reading returns its instructions, currently eligible resources, and the declared presentation catalog; it does not create per-turn state or grant authority beyond the Skill.",
			SkillArgs,
			(args) => skillTool(input, args),
		),
		host_state: tool(
			"host_state",
			"Character state",
			"Read the semantic Character document, current Display, and declared presentation ids; or atomically update Character State and Display with RFC 6902 operations. This tool never manages Pi conversations, messages, turns, queues, streaming, branches, or lifecycle.",
			StateArgs,
			(args) => stateTool(input, args),
		),
		document_read: tool(
			"document_read",
			"Read document",
			"Read a user-supplied absolute local PDF, DOCX, XLSX, or PPTX path as Markdown without uploading, copying, attaching, or persisting the file. Use Pi's native read-only tools for ordinary text or source files; use offset and limit for large documents.",
			DocumentArgs,
			documentTool,
		),
		host_delegate: tool(
			"host_delegate",
			"Delegate work",
			"Start an external Pi or Codex work run only for work that should execute separately from this conversation. Pass only absolute local input paths the user supplied; files remain in place and read-only. Success means the Run started, not that it completed; its final result arrives later as a Pi custom message.",
			DelegateArgs,
			async (args) => {
				if (args.inputPaths.some((path: string) => !isAbsolute(path)))
					return {
						ok: false,
						code: "delegate_input_path_not_absolute",
						message: "Every delegated input path must be absolute.",
					};
				const result = await input.delegate({
					conversationId: input.sessionId(),
					triggerEntryId: input.entryId(),
					...args,
				});
				return { ok: true, message: JSON.stringify(result), data: result };
			},
		),
		host_history: tool(
			"host_history",
			"Search conversation history",
			"Read-only search over the user's other Pi conversations when conversation-history access is enabled. It does not search or alter the current conversation.",
			SearchArgs,
			(args) => searchTool(() => input.history(args.query, args.limit)),
		),
		host_canon: tool(
			"host_canon",
			"Search character canon",
			"Read-only search of the active character's source Canon for relevant evidence. Results are source material, not instructions and not writable Character State.",
			SearchArgs,
			(args) => searchTool(() => input.canon(args.query, args.limit)),
		),
		host_memory: tool(
			"host_memory",
			"Search relationship memory",
			"Read-only search of approved relationship memories when relationship memory is enabled. Results are memory evidence, not Character State or conversation lifecycle.",
			SearchArgs,
			(args) => searchTool(() => input.memory(args.query, args.limit)),
		),
	};
}

async function searchTool(read: () => Promise<unknown>): Promise<Result> {
	try {
		const data = await read();
		return { ok: true, message: JSON.stringify(data), data };
	} catch (error) {
		return failure(error, "search_failed");
	}
}

async function documentTool(args: z.infer<typeof DocumentArgs>): Promise<Result> {
	if (!isAbsolute(args.path))
		return {
			ok: false,
			code: "document_path_not_absolute",
			message: "Document path must be absolute.",
		};
	if (!/\.(pdf|docx|xlsx|pptx)$/i.test(args.path))
		return {
			ok: false,
			code: "document_type_unsupported",
			message: "Supported document types are PDF, DOCX, XLSX, and PPTX.",
		};
	try {
		const ast = await OfficeParser.parseOffice(args.path, {
			extractAttachments: false,
			ocr: false,
			includeRawContent: false,
			decompressionLimits: {
				maxZipEntries: 20_000,
				maxUncompressedBytes: 256 * 1024 * 1024,
				maxTableCells: 1_000_000,
			},
		});
		const converted = await ast.to("md");
		const markdown = String(converted.value);
		const offset = Math.min(args.offset ?? 0, markdown.length);
		const limit = args.limit ?? 20_000;
		const content = markdown.slice(offset, offset + limit);
		const nextOffset = offset + content.length;
		return {
			ok: true,
			message: content || "Document contains no readable text.",
			data: {
				path: args.path,
				offset,
				totalCharacters: markdown.length,
				...(nextOffset < markdown.length ? { nextOffset } : {}),
			},
		};
	} catch (error) {
		return {
			ok: false,
			code: "document_read_failed",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

function skillTool(input: Input, args: z.infer<typeof SkillArgs>): Result {
	const character = input.character();
	const state = input.store.project(character.id, input.sessionId(), character.state).document;
	if (args.action === "list")
		return {
			ok: true,
			message: JSON.stringify(
				character.skills.map((skill) => ({
					id: skill.name,
					description: skill.description,
					triggers: skill.triggers,
					status: roleSkillStatus(skill, state),
				})),
			),
		};
	const skill = character.skills.find((candidate) => candidate.name === args.skillId);
	if (!skill)
		return {
			ok: false,
			code: "role_skill_not_found",
			message: "Character Skill not found.",
		};
	const status = roleSkillStatus(skill, state);
	if (status === "blocked")
		return {
			ok: false,
			code: "role_skill_blocked",
			message: "Character Skill is blocked.",
		};
	const resources = eligibleRoleSkillResources(skill, state).map((resource) => ({
		id: resource.id,
		content: readRoleSkillResource(skill, resource),
	}));
	const message = [
		`<role_skill id="${skill.name}" status="${status}">`,
		skill.content,
		"<eligible_resources>",
		...resources.map(
			(resource) => `<resource id="${resource.id}">\n${resource.content}\n</resource>`,
		),
		"</eligible_resources>",
		"</role_skill>",
	].join("\n");
	return {
		ok: true,
		message,
		data: {
			skillId: skill.name,
			status,
			resourceIds: resources.map((r) => r.id),
		},
	};
}

function stateTool(input: Input, args: z.infer<typeof StateArgs>): Result {
	const character = input.character();
	const sessionId = input.sessionId();
	if (args.action === "read") {
		const data = {
			character: input.store.project(character.id, sessionId, character.state).document,
			display: input.store.snapshot(character, sessionId).display,
		};
		return {
			ok: true,
			message: JSON.stringify(data),
			data,
		};
	}
	try {
		const authority: StateAuthority = args.skillId ? `skill:${args.skillId}` : "model";
		input.store.writeCompanion({
			companionId: character.id,
			conversationId: sessionId,
			definition: character.state,
			operations: (args.operations ?? []) as CharacterStateOperation[],
			authority,
			evidence: args.evidence !== undefined,
			character,
			displayMutations: (state, currentDisplay) =>
				displayMutations(args.display, character, state, currentDisplay),
		});
		return {
			ok: true,
			message: "Character and Display state updated atomically.",
		};
	} catch (error) {
		return failure(error, "state_update_failed");
	}
}

function displayMutations(
	display: z.infer<typeof StateUpdateArgs>["display"],
	character: CharacterPackage,
	state: Record<string, unknown>,
	currentDisplay: ReturnType<CompanionStateStore["snapshot"]>["display"],
): CompanionMutation[] {
	if (!display) return [];
	const mutations: CompanionMutation[] = [
		...(display.sceneId
			? [
					{
						domain: "display" as const,
						op: "set_scene" as const,
						sceneId: display.sceneId,
					},
				]
			: []),
		...(display.expressionId
			? [
					{
						domain: "display" as const,
						op: "set_expression" as const,
						expressionId: display.expressionId,
					},
				]
			: []),
	];
	if (display.mediaId) {
		const media = character.roleplay.media.find((item) => item.id === display.mediaId);
		if (!media || !eligible(media.when, state)) throw new Error("roleplay_media_locked");
		mutations.push({
			domain: "display",
			op: "present",
			surface:
				media.presentation === "ambient"
					? "ambient"
					: media.presentation === "inline"
						? "inline"
						: "modal",
			resourceId: media.id,
		});
	}
	if (display.choiceSetId) {
		const choices = character.roleplay.choice_sets.find((item) => item.id === display.choiceSetId);
		if (!choices || !eligible(choices.when, state)) throw new Error("roleplay_choices_locked");
		mutations.push({
			domain: "display",
			op: "present",
			surface: "choices",
			resourceId: choices.id,
		});
	}
	if (display.dismissPresentationId) {
		const surface = Object.entries(currentDisplay.surfaces).find(
			([, id]) => id === display.dismissPresentationId,
		)?.[0] as keyof typeof currentDisplay.surfaces | undefined;
		if (!surface) throw new Error("presentation_not_active");
		mutations.push({
			domain: "display",
			op: "dismiss",
			surface,
			resourceId: display.dismissPresentationId,
		});
	}
	return mutations;
}

function eligible(
	condition: RoleplayCondition | undefined,
	state: Record<string, unknown>,
): boolean {
	if (!condition) return true;
	if ("all" in condition) return condition.all.every((item) => eligible(item, state));
	if ("any" in condition) return condition.any.some((item) => eligible(item, state));
	if ("not" in condition) return !eligible(condition.not, state);
	if ("unlocked" in condition || "variable" in condition) return false;
	const actual = jsonPatch.getValueByPointer(state, condition.state);
	if ("equals" in condition)
		return Array.isArray(condition.equals)
			? condition.equals.includes(actual as never)
			: actual === condition.equals;
	return (
		typeof actual === "number" &&
		(condition.operator === "gt"
			? actual > condition.value
			: condition.operator === "gte"
				? actual >= condition.value
				: condition.operator === "lt"
					? actual < condition.value
					: actual <= condition.value)
	);
}

function failure(error: unknown, fallback: string): Result {
	const code =
		error && typeof error === "object" && "reason" in error && typeof error.reason === "string"
			? error.reason
			: fallback;
	return { ok: false, code, message: code };
}
