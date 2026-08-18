/**
 * pi-agent-core accepts JSON Schema-compatible tool descriptors, while Host
 * contracts are authored in Zod. Keep Zod as the only validation authority:
 * the JSON Schema is model-facing metadata and execution always reparses.
 */

import { toJsonSchema, type z } from "@bear-harness/schema";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export interface ZodCoreTool<TSchema extends z.ZodType> {
	name: string;
	label: string;
	description: string;
	schema: TSchema;
	execute(
		toolCallId: string,
		params: z.infer<TSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown>>;
}

/**
 * The cast is constrained to the third-party boundary. pi-ai validates this
 * JSON schema for model protocol compatibility; Zod validates again before
 * any Host side effect runs.
 */
export function toCoreTool<TSchema extends z.ZodType>(tool: ZodCoreTool<TSchema>): AgentTool {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: toJsonSchema(tool.schema) as never,
		prepareArguments: (value: unknown) => tool.schema.parse(value) as never,
		execute: (toolCallId, value, signal) =>
			tool.execute(toolCallId, tool.schema.parse(value), signal),
	};
}
