/**
 * Cyber Bear host adapter for the vendored, host-neutral TdaiCore.
 *
 * This adapter deliberately has no plugin registration surface. It maps the
 * product's ProviderCatalog and ModelRegistry into the runner contract used by
 * TdaiCore, while keeping all runtime state under the injected product data
 * directory.
 *
 * LLM execution is powered by the vendored pi-ai runtime (`@earendil-works/pi-ai`),
 * the same model runtime the Companion itself uses:
 * - `enableTools: false`: pure text output (L1 extraction, L1 dedup) via `completeSimple`
 * - `enableTools: true`: automatic tool-call loop (L2 scene, L3 persona) via
 *   `complete` with `Context.tools`, feeding `ToolResultMessage`s back until the
 *   model stops or `MAX_TOOL_ITERATIONS` is exceeded.
 *
 * Tool sandbox:
 *   When tools are enabled, three basic file operations are exposed:
 *   `read_file`, `write_to_file`, `replace_in_file`.
 *   All file paths are resolved relative to `workspaceDir`, enforcing sandbox boundaries.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";
import type {
	HostAdapter,
	LLMRunner,
	LLMRunnerCreateOptions,
	LLMRunnerFactory,
	LLMRunParams,
	Logger,
	RuntimeContext,
} from "@bear-harness/tdai-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	Models,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../models/registry.js";
import type { ProviderCatalog } from "../providers/catalog.js";

export interface CyberBearHostAdapterOptions {
	readonly dataDir: string;
	readonly workspaceDir?: string;
	readonly userId: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
	readonly companionId: string;
	readonly providers: ProviderCatalog;
	readonly models: ModelRegistry;
	readonly logger?: Logger;
}

const TAG = "[cyber-bear][tdai]";

// Max iterations in the tool-call loop to prevent infinite loops
const MAX_TOOL_ITERATIONS = 20;

function defaultLogger(): Logger {
	return {
		debug: (message) => console.debug(message),
		info: (message) => console.info(message),
		warn: (message) => console.warn(message),
		error: (message) => console.error(message),
	};
}

function modelRoute(modelRef: string | undefined, models: ModelRegistry, companionId: string) {
	if (modelRef) {
		const slash = modelRef.indexOf("/");
		if (slash <= 0 || slash === modelRef.length - 1) {
			throw new Error(`invalid Tdai model reference: ${modelRef}`);
		}
		return { providerId: modelRef.slice(0, slash), modelId: modelRef.slice(slash + 1) };
	}
	const route = models.defaults(companionId).reply;
	if (!route) {
		throw new Error("no configured Companion model is available for memory processing");
	}
	return { providerId: route.providerId, modelId: route.modelId };
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

// ============================
// Sandboxed tool execution helpers
// ============================

function resolveSandboxedPath(workspaceDir: string, relativePath: string): string | null {
	const root = path.resolve(workspaceDir);
	const resolved = path.resolve(root, relativePath);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return null;
	}
	return resolved;
}

/**
 * Sandboxed file tool: the pi-ai `Tool` declaration plus the host-side
 * executor the runner drives when the model emits a matching tool call.
 */
interface SandboxedTool extends Tool {
	execute(args: Record<string, unknown>): Promise<string>;
}

function createSandboxedTools(workspaceDir: string, logger?: Logger): SandboxedTool[] {
	const root = path.resolve(workspaceDir);
	return [
		{
			name: "read_file",
			description: "Read the contents of a file at the given relative path.",
			parameters: Type.Object({
				path: Type.String({ description: "Relative file path to read." }),
			}),
			async execute(args) {
				const filePath = typeof args?.path === "string" ? args.path : "";
				if (!filePath) return JSON.stringify({ error: "path must be a non-empty string." });
				const resolved = resolveSandboxedPath(root, filePath);
				if (!resolved)
					return JSON.stringify({ error: `Path "${filePath}" escapes workspace boundary.` });
				try {
					return await fsPromises.readFile(resolved, "utf-8");
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger?.warn?.(`${TAG} read_file failed: ${msg}`);
					return JSON.stringify({ error: msg });
				}
			},
		},
		{
			name: "write_to_file",
			description: "Write content to a file at the given relative path. Creates or overwrites.",
			parameters: Type.Object({
				path: Type.String({ description: "Relative file path to write." }),
				content: Type.String({ description: "Content to write." }),
			}),
			async execute(args) {
				const filePath = typeof args?.path === "string" ? args.path : "";
				const content = typeof args?.content === "string" ? args.content : "";
				if (!filePath) return JSON.stringify({ error: "path must be a non-empty string." });
				const resolved = resolveSandboxedPath(root, filePath);
				if (!resolved)
					return JSON.stringify({ error: `Path "${filePath}" escapes workspace boundary.` });
				try {
					await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
					await fsPromises.writeFile(resolved, content, "utf-8");
					return JSON.stringify({ success: true });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger?.warn?.(`${TAG} write_to_file failed: ${msg}`);
					return JSON.stringify({ error: msg });
				}
			},
		},
		{
			name: "replace_in_file",
			description: "Replace an exact substring in a file with new content.",
			parameters: Type.Object({
				path: Type.String({ description: "Relative file path." }),
				old_str: Type.String({ description: "Exact string to find and replace." }),
				new_str: Type.String({ description: "Replacement string." }),
			}),
			async execute(args) {
				const filePath = typeof args?.path === "string" ? args.path : "";
				const oldStr = typeof args?.old_str === "string" ? args.old_str : "";
				const newStr = typeof args?.new_str === "string" ? args.new_str : "";
				if (!filePath) return JSON.stringify({ error: "path must be a non-empty string." });
				if (!oldStr) return JSON.stringify({ error: "old_str cannot be empty." });
				const resolved = resolveSandboxedPath(root, filePath);
				if (!resolved)
					return JSON.stringify({ error: `Path "${filePath}" escapes workspace boundary.` });
				try {
					const existing = await fsPromises.readFile(resolved, "utf-8");
					if (!existing.includes(oldStr)) {
						return JSON.stringify({ error: `old_str not found in file "${filePath}".` });
					}
					const updated = existing.replace(oldStr, newStr);
					await fsPromises.writeFile(resolved, updated, "utf-8");
					return JSON.stringify({ success: true });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger?.warn?.(`${TAG} replace_in_file failed: ${msg}`);
					return JSON.stringify({ error: msg });
				}
			},
		},
	];
}

function toolResultMessage(toolCall: ToolCall, text: string, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

class CyberBearLLMRunner implements LLMRunner {
	constructor(
		private readonly providers: ProviderCatalog,
		private readonly models: ModelRegistry,
		private readonly companionId: string,
		private readonly logger: Logger,
		private readonly modelRef?: string,
		private readonly enableTools = false,
		private readonly workspaceDir?: string,
	) {}

	private async resolveModel(): Promise<{ models: Models; model: Model<Api> }> {
		const route = modelRoute(this.modelRef, this.models, this.companionId);
		const runtime = await this.providers.getModels();
		const model =
			runtime.getModel(route.providerId, route.modelId) ??
			(await runtime.getAvailable(route.providerId)).find(
				(candidate) => candidate.id === route.modelId,
			);
		if (!model) {
			throw new Error(
				`configured memory model is unavailable: ${route.providerId}/${route.modelId}`,
			);
		}
		return { models: runtime, model };
	}

	async run(params: LLMRunParams): Promise<string> {
		const { models, model } = await this.resolveModel();
		this.logger.debug?.(
			`${TAG} LLM task=${params.taskId} model=${model.provider}/${model.id} tools=${this.enableTools}`,
		);
		const timeoutMs = params.timeoutMs ?? 120_000;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.execute(params, models, model),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error(`Tdai LLM task timed out after ${timeoutMs}ms`)),
						timeoutMs,
					);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
	}

	private async execute(params: LLMRunParams, models: Models, model: Model<Api>): Promise<string> {
		const messages: Message[] = [{ role: "user", content: params.prompt, timestamp: Date.now() }];
		const tools = this.enableTools
			? createSandboxedTools(params.workspaceDir ?? this.workspaceDir ?? process.cwd(), this.logger)
			: undefined;
		const context: Context = {
			systemPrompt: params.systemPrompt,
			messages,
			tools,
		};

		if (!this.enableTools) {
			const result = await models.completeSimple(model, context, {
				maxTokens: params.maxTokens,
			});
			return assistantText(result);
		}

		// Tool-call loop: run the sandboxed tools and feed each result back as a
		// ToolResultMessage until the model stops or MAX_TOOL_ITERATIONS is hit.
		let accumulatedText = "";
		for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
			const message = await models.complete(model, context, {
				maxTokens: params.maxTokens,
			});
			accumulatedText += assistantText(message);
			const toolCalls = message.content.filter(
				(part): part is ToolCall => part.type === "toolCall",
			);
			if (toolCalls.length === 0) {
				return accumulatedText.trim();
			}
			context.messages.push(message);
			for (const toolCall of toolCalls) {
				const tool = tools?.find((candidate) => candidate.name === toolCall.name);
				if (!tool) {
					context.messages.push(
						toolResultMessage(toolCall, `Unknown tool: ${toolCall.name}`, true),
					);
					continue;
				}
				let text: string;
				let isError = false;
				try {
					text = await tool.execute(toolCall.arguments);
				} catch (err) {
					text = err instanceof Error ? err.message : String(err);
					isError = true;
				}
				context.messages.push(toolResultMessage(toolCall, text, isError));
			}
		}
		this.logger.warn?.(
			`${TAG} tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations; returning accumulated text`,
		);
		return accumulatedText.trim();
	}
}

class CyberBearLLMRunnerFactory implements LLMRunnerFactory {
	constructor(
		private readonly providers: ProviderCatalog,
		private readonly models: ModelRegistry,
		private readonly companionId: string,
		private readonly logger: Logger,
		private readonly workspaceDir?: string,
	) {}

	createRunner(options?: LLMRunnerCreateOptions): LLMRunner {
		return new CyberBearLLMRunner(
			this.providers,
			this.models,
			this.companionId,
			this.logger,
			options?.modelRef,
			options?.enableTools ?? false,
			this.workspaceDir,
		);
	}
}

export class CyberBearHostAdapter implements HostAdapter {
	readonly hostType = "standalone" as const;
	private readonly context: RuntimeContext;
	private readonly logger: Logger;
	private readonly runnerFactory: LLMRunnerFactory;

	constructor(options: CyberBearHostAdapterOptions) {
		this.logger = options.logger ?? defaultLogger();
		this.context = {
			userId: options.userId,
			sessionId: options.sessionId ?? "memory-runtime",
			sessionKey: options.sessionKey ?? "memory-runtime",
			platform: "standalone",
			agentIdentity: options.companionId,
			agentContext: "primary",
			workspaceDir: options.workspaceDir ?? options.dataDir,
			dataDir: options.dataDir,
		};
		this.runnerFactory = new CyberBearLLMRunnerFactory(
			options.providers,
			options.models,
			options.companionId,
			this.logger,
			this.context.workspaceDir,
		);
	}

	getRuntimeContext(): RuntimeContext {
		return this.context;
	}

	getLogger(): Logger {
		return this.logger;
	}

	getLLMRunnerFactory(): LLMRunnerFactory {
		return this.runnerFactory;
	}
}
