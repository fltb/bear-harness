import {
	createEmbeddingService,
	type EmbeddingService,
	type MemoryTdaiConfig,
} from "@bear-harness/tdai-core";
import type { CanonEmbeddingService } from "../canon/service.js";
import type { DeepPartial } from "./tencentdb-runtime.js";

type Configuration = DeepPartial<MemoryTdaiConfig>["embedding"];
type Factory = typeof createEmbeddingService;

/** Host owns the provider. Character consumers borrow it without disposal rights. */
export class SharedEmbeddingRuntime {
	private service?: EmbeddingService;
	private opening?: Promise<EmbeddingService | undefined>;
	private canon?: CanonEmbeddingService;
	private resetting?: Promise<void>;
	private closed = false;
	private readonly calls = new Set<Promise<unknown>>();
	private localQueue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly configuration: () => Configuration,
		private readonly create: Factory = createEmbeddingService,
	) {}

	async get(): Promise<EmbeddingService | undefined> {
		await this.resetting;
		if (this.closed) throw new Error("Shared embedding runtime is closed");
		if (this.opening) return this.opening;
		const pending = this.open();
		this.opening = pending;
		try {
			return await pending;
		} catch (error) {
			const failed = this.service;
			await failed?.close?.();
			if (this.service === failed) this.service = undefined;
			if (this.opening === pending) this.opening = undefined;
			throw error;
		}
	}

	private async open(): Promise<EmbeddingService | undefined> {
		const config = this.configuration();
		if (!config?.enabled || !config.provider || config.provider === "none") return undefined;
		const service = this.create(
			config.provider === "local"
				? {
						provider: "local",
						modelPath: config.modelPath,
						modelCacheDir: config.modelCacheDir,
						dimensions: config.dimensions,
						hfEndpoint: config.hfEndpoint,
						download: false,
					}
				: {
						provider: config.provider,
						baseUrl: config.baseUrl ?? "",
						apiKey: config.apiKey ?? "",
						model: config.model ?? "",
						dimensions: config.dimensions ?? 0,
						sendDimensions: config.sendDimensions,
						maxInputChars: config.maxInputChars,
						timeoutMs: config.timeoutMs,
					},
		);
		this.service = service;
		service.startWarmup();
		const readiness = service as EmbeddingService & { waitForReady?: () => Promise<void> };
		await readiness.waitForReady?.();
		if (!service.isReady()) throw new Error("Shared embedding provider is not ready");
		const ready = () =>
			!this.closed && !this.resetting && this.service === service && service.isReady();
		const run = <T>(work: () => Promise<T>): Promise<T> => {
			if (!ready()) return Promise.reject(new Error("Shared embedding provider changed"));
			const pending = config.provider === "local" ? this.localQueue.then(work) : work();
			if (config.provider === "local") this.localQueue = pending.catch(() => undefined);
			return this.track(pending);
		};
		// No close method: only the installation owner may release this provider.
		const borrowed: EmbeddingService = {
			isReady: ready,
			getDimensions: () => service.getDimensions(),
			getProviderInfo: () => service.getProviderInfo(),
			startWarmup: () => {},
			embed: (text, options) => run(() => service.embed(text, options)),
			embedBatch: (texts, options) => run(() => service.embedBatch(texts, options)),
		};
		this.canon = {
			isReady: ready,
			getDimensions: () => service.getDimensions(),
			getProviderInfo: () => {
				const info = service.getProviderInfo();
				return config.provider === "local"
					? { ...info, model: `${info.model}:canon-retrieval-mean-480-v2` }
					: info;
			},
			embed: (text, purpose = "document") =>
				run(() =>
					config.provider === "local"
						? embedLocalText(
								service,
								text,
								!config.modelPath || /embeddinggemma/i.test(config.modelPath)
									? purpose === "query"
										? "task: search result | query: "
										: "title: none | text: "
									: "",
							)
						: service.embed(text),
				),
		};
		return borrowed;
	}

	async getCanon(): Promise<CanonEmbeddingService | undefined> {
		const service = await this.get();
		return service ? this.canon : undefined;
	}

	private async track<T>(pending: Promise<T>): Promise<T> {
		this.calls.add(pending);
		try {
			return await pending;
		} finally {
			this.calls.delete(pending);
		}
	}

	reset(): Promise<void> {
		if (this.resetting) return this.resetting;
		this.resetting = (async () => {
			await this.opening?.catch(() => undefined);
			await Promise.allSettled(this.calls);
			await this.service?.close?.();
			this.service = undefined;
			this.opening = undefined;
			this.canon = undefined;
			this.localQueue = Promise.resolve();
		})().finally(() => {
			this.resetting = undefined;
		});
		return this.resetting;
	}

	close(): Promise<void> {
		this.closed = true;
		return this.reset();
	}
}

// The local adapter limits each input to 512 characters. Pool bounded windows
// so existing long Canon chunks remain fully represented rather than truncated.
async function embedLocalText(
	service: EmbeddingService,
	text: string,
	prefix: string,
): Promise<Float32Array> {
	if (text.length <= 480) return service.embed(prefix + text);
	const pooled = new Float32Array(service.getDimensions());
	for (let start = 0; start < text.length; start += 480) {
		const part = text.slice(start, start + 480);
		const vector = await service.embed(prefix + part);
		if (vector.length !== pooled.length) throw new Error("Canon embedding dimension mismatch");
		for (let index = 0; index < pooled.length; index++)
			pooled[index] = (pooled[index] ?? 0) + (vector[index] ?? 0) * part.length;
	}
	const norm = Math.hypot(...pooled);
	if (!Number.isFinite(norm) || norm === 0) throw new Error("Canon embedding vector is invalid");
	return pooled.map((value) => value / norm);
}
