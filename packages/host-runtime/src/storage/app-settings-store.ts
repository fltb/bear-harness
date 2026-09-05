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

export type FirstRunStage = "model" | "embedding" | "role";

/** Product-level settings persisted outside role onboarding decisions. */
export interface AppSettingsRecord {
	firstRunStage: FirstRunStage;
	systemModelOnboardingComplete: boolean;
	embeddingOnboardingComplete: boolean;
	relationshipMemoryEnabled: boolean;
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

export type AppSettingsPatch = Partial<
	Pick<
		AppSettingsRecord,
		"networkProxy" | "memoryVectorService" | "systemModelDefaults" | "modelDownloadSource"
	>
>;

export interface EmbeddingOnboardingCompletion {
	memoryVectorService: AppSettingsRecord["memoryVectorService"];
}

const SINGLETON_ID = 1;

/** Read/write the singleton app_settings row. */
export class AppSettingsStore {
	constructor(private readonly db: AppDatabase) {}

	load(): AppSettingsRecord {
		const row = this.db
			.select({
				systemModelOnboardingComplete: appSettings.systemModelOnboardingComplete,
				embeddingOnboardingComplete: appSettings.embeddingOnboardingComplete,
				relationshipMemoryEnabled: appSettings.relationshipMemoryEnabled,
				networkProxyJson: appSettings.networkProxyJson,
				memoryVectorServiceJson: appSettings.memoryVectorServiceJson,
				systemModelDefaultsJson: appSettings.systemModelDefaultsJson,
				modelDownloadMirrorJson: appSettings.modelDownloadMirrorJson,
			})
			.from(appSettings)
			.where(eq(appSettings.id, SINGLETON_ID))
			.get();
		if (!row) throw new Error("app settings are missing");
		const systemModelOnboardingComplete = row.systemModelOnboardingComplete === 1;
		const embeddingOnboardingComplete = row.embeddingOnboardingComplete === 1;
		const memoryVectorService = JSON.parse(
			row.memoryVectorServiceJson,
		) as AppSettingsRecord["memoryVectorService"];
		return {
			firstRunStage: systemModelOnboardingComplete
				? embeddingOnboardingComplete
					? "role"
					: "embedding"
				: "model",
			systemModelOnboardingComplete,
			embeddingOnboardingComplete,
			relationshipMemoryEnabled: memoryVectorService.enabled,
			networkProxy: JSON.parse(row.networkProxyJson) as AppSettingsRecord["networkProxy"],
			memoryVectorService,
			systemModelDefaults: JSON.parse(row.systemModelDefaultsJson) as SystemModelDefaults,
			modelDownloadSource: JSON.parse(
				row.modelDownloadMirrorJson,
			) as AppSettingsRecord["modelDownloadSource"],
		};
	}

	save(patch: AppSettingsPatch): AppSettingsRecord {
		const current = this.load();
		const memoryVectorService = patch.memoryVectorService ?? current.memoryVectorService;
		this.db
			.update(appSettings)
			.set({
				networkProxyJson: JSON.stringify(patch.networkProxy ?? current.networkProxy),
				memoryVectorServiceJson: JSON.stringify(memoryVectorService),
				systemModelDefaultsJson: JSON.stringify(
					patch.systemModelDefaults ?? current.systemModelDefaults,
				),
				modelDownloadMirrorJson: JSON.stringify(
					patch.modelDownloadSource ?? current.modelDownloadSource,
				),
				relationshipMemoryEnabled: memoryVectorService.enabled ? 1 : 0,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(appSettings.id, SINGLETON_ID))
			.run();
		return this.load();
	}

	completeSystemModelOnboarding(defaults: SystemModelDefaults): AppSettingsRecord {
		this.db.transaction((transaction) => {
			transaction
				.update(appSettings)
				.set({
					systemModelDefaultsJson: JSON.stringify(defaults),
					systemModelOnboardingComplete: 1,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(appSettings.id, SINGLETON_ID))
				.run();
		});
		return this.load();
	}

	clearSystemModelOnboarding(): AppSettingsRecord {
		this.db.transaction((transaction) => {
			transaction
				.update(appSettings)
				.set({
					systemModelDefaultsJson: JSON.stringify({ vision: { mode: "auto" } }),
					systemModelOnboardingComplete: 0,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(appSettings.id, SINGLETON_ID))
				.run();
		});
		return this.load();
	}

	completeEmbeddingOnboarding(completion: EmbeddingOnboardingCompletion): AppSettingsRecord {
		this.db.transaction((transaction) => {
			transaction
				.update(appSettings)
				.set({
					memoryVectorServiceJson: JSON.stringify(completion.memoryVectorService),
					relationshipMemoryEnabled:
						completion.memoryVectorService.enabled &&
						completion.memoryVectorService.provider !== "none"
							? 1
							: 0,
					embeddingOnboardingComplete: 1,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(appSettings.id, SINGLETON_ID))
				.run();
		});
		return this.load();
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
