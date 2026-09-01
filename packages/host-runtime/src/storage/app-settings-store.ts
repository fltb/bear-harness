import { eq } from "drizzle-orm";
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

/** Read/write the singleton app_settings row. */
export class AppSettingsStore {
	constructor(private readonly db: AppDatabase) {}

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
		if (!row) throw new Error("app settings are missing");
		return {
			firstRunStage: row.firstRunStage as AppSettingsRecord["firstRunStage"],
			networkProxy: JSON.parse(row.networkProxyJson) as AppSettingsRecord["networkProxy"],
			memoryVectorService: JSON.parse(
				row.memoryVectorServiceJson,
			) as AppSettingsRecord["memoryVectorService"],
			systemModelDefaults: JSON.parse(row.systemModelDefaultsJson) as SystemModelDefaults,
			modelDownloadSource: JSON.parse(
				row.modelDownloadMirrorJson,
			) as AppSettingsRecord["modelDownloadSource"],
		};
	}

	save(patch: Partial<AppSettingsRecord>): AppSettingsRecord {
		const current = this.load();
		const next: AppSettingsRecord = {
			firstRunStage: patch.firstRunStage ?? current.firstRunStage,
			networkProxy: patch.networkProxy ?? current.networkProxy,
			memoryVectorService: patch.memoryVectorService ?? current.memoryVectorService,
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
