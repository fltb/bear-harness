import { eq } from "drizzle-orm";
import type { AppDatabase } from "./database.js";
import { appSettings } from "./schema.js";

/** Product-level settings persisted outside role onboarding decisions. */
export interface AppSettingsRecord {
	firstRunStage: "model" | "embedding" | "role";
	networkProxy: {
		mode: "direct" | "auto" | "manual";
		url?: string;
		bypass?: string[];
	};
	memoryVectorService: {
		enabled: boolean;
		provider: "none" | "remote" | "local";
		baseUrl?: string;
		apiKey?: string;
		model?: string;
		dimensions?: number;
		localModel?: string;
		customPath?: string;
	};
	modelDownloadSource:
		| { type: "official" }
		| { type: "hf-mirror" }
		| { type: "custom"; endpoint: string };
}

const SINGLETON_ID = 1;

export function defaultAppSettings(): AppSettingsRecord {
	return {
		firstRunStage: "model",
		networkProxy: { mode: "auto" },
		memoryVectorService: { enabled: false, provider: "none" },
		modelDownloadSource: { type: "official" },
	};
}

function parseJson<T>(json: string, fallback: T): T {
	try {
		const parsed = JSON.parse(json) as T;
		return parsed && typeof parsed === "object" ? parsed : fallback;
	} catch {
		return fallback;
	}
}

function parseModelDownloadSource(json: string): AppSettingsRecord["modelDownloadSource"] {
	const parsed = parseJson<unknown>(json, null);
	if (!parsed || typeof parsed !== "object") return { type: "official" };
	const value = parsed as { type?: unknown; endpoint?: unknown };
	if (value.type === "hf-mirror") return { type: "hf-mirror" };
	if (value.type === "custom" && typeof value.endpoint === "string")
		return { type: "custom", endpoint: value.endpoint };
	if (typeof value.endpoint === "string") return { type: "custom", endpoint: value.endpoint };
	return { type: "official" };
}

function safeHttpUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
			return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function parseNetworkProxy(json: string): AppSettingsRecord["networkProxy"] {
	const parsed = parseJson<unknown>(json, null);
	if (!parsed || typeof parsed !== "object") return { mode: "auto" };
	const value = parsed as { mode?: unknown; url?: unknown; bypass?: unknown };
	if (value.mode === "direct" || value.mode === "auto") {
		return {
			mode: value.mode,
			...(Array.isArray(value.bypass) && value.bypass.every((item) => typeof item === "string")
				? { bypass: value.bypass }
				: {}),
		};
	}
	const url = safeHttpUrl(value.url);
	return value.mode === "manual" && url ? { mode: "manual", url } : { mode: "auto" };
}

function parseMemoryVectorService(json: string): AppSettingsRecord["memoryVectorService"] {
	const parsed = parseJson<unknown>(json, null);
	if (!parsed || typeof parsed !== "object") return { enabled: false, provider: "none" };
	const value = parsed as Record<string, unknown>;
	if (value.provider === "local" && value.enabled === true) {
		if (typeof value.localModel === "string") {
			return { enabled: true, provider: "local", localModel: value.localModel };
		}
		if (typeof value.customPath === "string") {
			return { enabled: true, provider: "local", customPath: value.customPath };
		}
	}
	if (value.provider === "remote" && value.enabled === true) {
		const baseUrl = safeHttpUrl(value.baseUrl);
		if (
			baseUrl &&
			typeof value.apiKey === "string" &&
			value.apiKey.length > 0 &&
			typeof value.model === "string" &&
			value.model.length > 0 &&
			typeof value.dimensions === "number" &&
			Number.isSafeInteger(value.dimensions) &&
			value.dimensions > 0
		) {
			return {
				enabled: true,
				provider: "remote",
				baseUrl,
				apiKey: value.apiKey,
				model: value.model,
				dimensions: value.dimensions,
			};
		}
	}
	return { enabled: false, provider: "none" };
}

/** Read/write the singleton app_settings row (migration 18). */
export class AppSettingsStore {
	constructor(private readonly db: AppDatabase) {}

	load(): AppSettingsRecord {
		const row = this.db
			.select({
				firstRunStage: appSettings.firstRunStage,
				networkProxyJson: appSettings.networkProxyJson,
				memoryVectorServiceJson: appSettings.memoryVectorServiceJson,
				modelDownloadMirrorJson: appSettings.modelDownloadMirrorJson,
			})
			.from(appSettings)
			.where(eq(appSettings.id, SINGLETON_ID))
			.get();
		if (!row) return defaultAppSettings();
		const defaults = defaultAppSettings();
		return {
			firstRunStage:
				row.firstRunStage === "embedding" || row.firstRunStage === "role"
					? row.firstRunStage
					: "model",
			networkProxy: parseNetworkProxy(row.networkProxyJson),
			memoryVectorService: parseMemoryVectorService(row.memoryVectorServiceJson),
			modelDownloadSource: parseModelDownloadSource(row.modelDownloadMirrorJson),
		};
	}

	save(patch: Partial<AppSettingsRecord>): AppSettingsRecord {
		const current = this.load();
		const memoryVectorService = patch.memoryVectorService
			? parseMemoryVectorService(JSON.stringify(patch.memoryVectorService))
			: current.memoryVectorService;
		if (
			patch.memoryVectorService &&
			JSON.stringify(memoryVectorService) !== JSON.stringify(patch.memoryVectorService)
		)
			throw { kind: "validation_failed", reason: "memory_vector_service_invalid" };
		const next: AppSettingsRecord = {
			firstRunStage: patch.firstRunStage ?? current.firstRunStage,
			networkProxy: patch.networkProxy ?? current.networkProxy,
			memoryVectorService,
			modelDownloadSource: patch.modelDownloadSource ?? current.modelDownloadSource,
		};
		this.db
			.update(appSettings)
			.set({
				firstRunStage: next.firstRunStage,
				networkProxyJson: JSON.stringify(next.networkProxy),
				memoryVectorServiceJson: JSON.stringify(next.memoryVectorService),
				modelDownloadMirrorJson: JSON.stringify(next.modelDownloadSource),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(appSettings.id, SINGLETON_ID))
			.run();
		return next;
	}
}
