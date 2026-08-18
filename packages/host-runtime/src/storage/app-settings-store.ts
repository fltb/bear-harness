import { eq } from "drizzle-orm";
import type { AppDatabase } from "./database.js";
import { appSettings } from "./schema.js";

/** Product-level settings persisted outside role onboarding decisions. */
export interface AppSettingsRecord {
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
		localModel?: "bge-base-zh" | "embeddinggemma" | "multilingual-e5" | "custom";
		customPath?: string;
	};
	modelDownloadMirror: {
		endpoint?: string;
	};
}

const SINGLETON_ID = 1;

export function defaultAppSettings(): AppSettingsRecord {
	return {
		networkProxy: { mode: "direct" },
		memoryVectorService: { enabled: false, provider: "none" },
		modelDownloadMirror: {},
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

/** Read/write the singleton app_settings row (migration 18). */
export class AppSettingsStore {
	constructor(private readonly db: AppDatabase) {}

	load(): AppSettingsRecord {
		const row = this.db
			.select({
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
			networkProxy: parseJson(row.networkProxyJson, defaults.networkProxy),
			memoryVectorService: parseJson(row.memoryVectorServiceJson, defaults.memoryVectorService),
			modelDownloadMirror: parseJson(row.modelDownloadMirrorJson, defaults.modelDownloadMirror),
		};
	}

	save(patch: Partial<AppSettingsRecord>): AppSettingsRecord {
		const current = this.load();
		const next: AppSettingsRecord = {
			networkProxy: patch.networkProxy ?? current.networkProxy,
			memoryVectorService: patch.memoryVectorService ?? current.memoryVectorService,
			modelDownloadMirror: patch.modelDownloadMirror ?? current.modelDownloadMirror,
		};
		this.db
			.update(appSettings)
			.set({
				networkProxyJson: JSON.stringify(next.networkProxy),
				memoryVectorServiceJson: JSON.stringify(next.memoryVectorService),
				modelDownloadMirrorJson: JSON.stringify(next.modelDownloadMirror),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(appSettings.id, SINGLETON_ID))
			.run();
		return next;
	}
}
