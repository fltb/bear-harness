/**
 * Cyber Bear host adapter for the vendored, host-neutral TdaiCore.
 *
 * This adapter deliberately has no plugin registration surface. It maps the
 * product's ProviderCatalog and ModelRegistry into the runner contract used by
 * TdaiCore, while keeping all runtime state under the injected product data
 * directory.
 */

import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	Models,
} from "@earendil-works/pi-ai";
import type {
	HostAdapter,
	LLMRunParams,
	LLMRunner,
	LLMRunnerCreateOptions,
	LLMRunnerFactory,
	Logger,
	RuntimeContext,
} from "@bear-harness/tdai-core";
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

class CyberBearLLMRunner implements LLMRunner {
	constructor(
		private readonly providers: ProviderCatalog,
		private readonly models: ModelRegistry,
		private readonly companionId: string,
		private readonly logger: Logger,
		private readonly modelRef?: string,
	) {}

	private async resolveModel(): Promise<{ models: Models; model: Model<Api> }> {
		const route = modelRoute(this.modelRef, this.models, this.companionId);
		const runtime = await this.providers.getModels();
		const model =
			runtime.getModel(route.providerId, route.modelId) ??
			(await runtime.getAvailable(route.providerId)).find((candidate) => candidate.id === route.modelId);
		if (!model) {
			throw new Error(`configured memory model is unavailable: ${route.providerId}/${route.modelId}`);
		}
		return { models: runtime, model };
	}

	async run(params: LLMRunParams): Promise<string> {
		const { models, model } = await this.resolveModel();
		const context: Context = {
			systemPrompt: params.systemPrompt,
			messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
		};
		this.logger.debug?.(`[cyber-bear][tdai] LLM task=${params.taskId} model=${model.provider}/${model.id}`);
		const completion = models.completeSimple(model, context, {
			maxTokens: params.maxTokens,
		});
		const timeoutMs = params.timeoutMs ?? 120_000;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				completion,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error(`Tdai LLM task timed out after ${timeoutMs}ms`)), timeoutMs);
				}),
			]);
			return assistantText(result);
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
	}
}

class CyberBearLLMRunnerFactory implements LLMRunnerFactory {
	constructor(
		private readonly providers: ProviderCatalog,
		private readonly models: ModelRegistry,
		private readonly companionId: string,
		private readonly logger: Logger,
	) {}

	createRunner(options?: LLMRunnerCreateOptions): LLMRunner {
		return new CyberBearLLMRunner(
			this.providers,
			this.models,
			this.companionId,
			this.logger,
			options?.modelRef,
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
