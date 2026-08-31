import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "./database.js";
import { appSettings } from "./schema.js";

export interface ModelRouteSetting {
	providerId: string;
	modelId: string;
}

export interface SystemModelDefaults {
	reply?: ModelRouteSetting;
	vision: { mode: "auto" } | { mode: "manual"; route: ModelRouteSetting };
}

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
		model?: string;
		dimensions?: number;
		localModel?: string;
		customPath?: string;
	};
	systemModelDefaults: SystemModelDefaults;
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
		systemModelDefaults: { vision: { mode: "auto" } },
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
				model: value.model,
				dimensions: value.dimensions,
			};
		}
	}
	return { enabled: false, provider: "none" };
}

function parseRoute(value: unknown): ModelRouteSetting | undefined {
	if (!value || typeof value !== "object") return undefined;
	const route = value as { providerId?: unknown; modelId?: unknown };
	return typeof route.providerId === "string" &&
		route.providerId.length > 0 &&
		typeof route.modelId === "string" &&
		route.modelId.length > 0
		? { providerId: route.providerId, modelId: route.modelId }
		: undefined;
}

function parseSystemModelDefaults(json: string): SystemModelDefaults {
	const parsed = parseJson<unknown>(json, null);
	if (!parsed || typeof parsed !== "object") return { vision: { mode: "auto" } };
	const value = parsed as { reply?: unknown; vision?: unknown };
	const reply = parseRoute(value.reply);
	const visionValue = value.vision as { mode?: unknown; route?: unknown } | undefined;
	const visionRoute = visionValue?.mode === "manual" ? parseRoute(visionValue.route) : undefined;
	return {
		...(reply ? { reply } : {}),
		vision:
			visionValue?.mode === "manual" && visionRoute
				? { mode: "manual", route: visionRoute }
				: { mode: "auto" },
	};
}

/** Read/write the singleton app_settings row (migration 18). */
export class AppSettingsStore {
	constructor(private readonly db: AppDatabase) {}

	/**
	 * Move the one legacy plaintext embedding key through a trusted Host-only
	 * importer before removing it from Settings. The importer must durably store
	 * the key or retain it for the current session before it resolves.
	 *
	 * Ordering is deliberately write-then-scrub: a failed import leaves the
	 * legacy value untouched, while a crash after import is safe to retry. The
	 * conditional update prevents a concurrent Settings change from being
	 * overwritten by the scrub.
	 */
	async migrateLegacyEmbeddingCredential(
		importCredential: (apiKey: string) => Promise<unknown>,
	): Promise<boolean> {
		const row = this.db
			.select({ memoryVectorServiceJson: appSettings.memoryVectorServiceJson })
			.from(appSettings)
			.where(eq(appSettings.id, SINGLETON_ID))
			.get();
		if (!row) return false;
		const parsed = parseJson<unknown>(row.memoryVectorServiceJson, null);
		if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, "apiKey")) return false;
		const sanitized = { ...(parsed as Record<string, unknown>) };
		const apiKey = sanitized.apiKey;
		if (typeof apiKey === "string" && apiKey.length > 0) {
			await importCredential(apiKey);
		}
		delete sanitized.apiKey;
		const result = this.db
			.update(appSettings)
			.set({
				memoryVectorServiceJson: JSON.stringify(sanitized),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(appSettings.id, SINGLETON_ID),
					eq(appSettings.memoryVectorServiceJson, row.memoryVectorServiceJson),
				),
			)
			.run();
		if (!result.changes) {
			throw new Error("legacy embedding credential changed during migration");
		}
		return true;
	}

	load(): AppSettingsRecord {
		const row = this.db
			.select({
				firstRunStage: appSettings.firstRunStage,
				networkProxyJson: appSettings.networkProxyJson,
				memoryVectorServiceJson: appSettings.memoryVectorServiceJson,
				systemModelDefaultsJson: appSettings.systemModelDefaultsJson,
				modelDownloadMirrorJson: appSettings.modelDownloadMirrorJson,
			})
			.from(appSettings)
			.where(eq(appSettings.id, SINGLETON_ID))
			.get();
		if (!row) return defaultAppSettings();
		return {
			firstRunStage:
				row.firstRunStage === "embedding" || row.firstRunStage === "role"
					? row.firstRunStage
					: "model",
			networkProxy: parseNetworkProxy(row.networkProxyJson),
			memoryVectorService: parseMemoryVectorService(row.memoryVectorServiceJson),
			systemModelDefaults: parseSystemModelDefaults(row.systemModelDefaultsJson),
			modelDownloadSource: parseModelDownloadSource(row.modelDownloadMirrorJson),
		};
	}

	save(patch: Partial<AppSettingsRecord>): AppSettingsRecord {
		const stored = this.db
			.select({ memoryVectorServiceJson: appSettings.memoryVectorServiceJson })
			.from(appSettings)
			.where(eq(appSettings.id, SINGLETON_ID))
			.get();
		const rawMemorySettings = stored
			? parseJson<unknown>(stored.memoryVectorServiceJson, null)
			: null;
		if (
			rawMemorySettings &&
			typeof rawMemorySettings === "object" &&
			Object.hasOwn(rawMemorySettings, "apiKey")
		) {
			throw { kind: "unavailable", reason: "legacy_embedding_credential_migration_required" };
		}
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
			systemModelDefaults: patch.systemModelDefaults ?? current.systemModelDefaults,
			modelDownloadSource: patch.modelDownloadSource ?? current.modelDownloadSource,
		};
		this.db
			.update(appSettings)
			.set({
				firstRunStage: next.firstRunStage,
				networkProxyJson: JSON.stringify(next.networkProxy),
				memoryVectorServiceJson: JSON.stringify(next.memoryVectorService),
				systemModelDefaultsJson: JSON.stringify(next.systemModelDefaults),
				modelDownloadMirrorJson: JSON.stringify(next.modelDownloadSource),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(appSettings.id, SINGLETON_ID))
			.run();
		return next;
	}

	saveSystemModelDefaults(defaults: SystemModelDefaults): SystemModelDefaults {
		const normalized = parseSystemModelDefaults(JSON.stringify(defaults));
		if (JSON.stringify(normalized) !== JSON.stringify(defaults)) {
			throw { kind: "validation_failed", reason: "system_model_defaults_invalid" };
		}
		this.db
			.update(appSettings)
			.set({
				systemModelDefaultsJson: JSON.stringify(defaults),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(appSettings.id, SINGLETON_ID))
			.run();
		return defaults;
	}
}
