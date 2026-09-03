import { CacheKey } from "@bear-harness/protocol/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import type {
	AppSettingsStore,
	SystemModelDefaults as StoredSystemModelDefaults,
} from "../storage/app-settings-store.js";
import type { AppDatabase } from "../storage/database.js";
import type { InvalidationHub } from "../storage/invalidation-hub.js";
import { appSettings, configuredModels, modelRouteSettings } from "../storage/schema.js";

export interface ModelRecord {
	providerId: string;
	modelId: string;
	label: string;
	supportsImages: boolean;
	createdAt: string;
}

export interface ModelDefaults {
	reply?: ModelRecord;
	vision: { mode: "auto" } | { mode: "manual"; route: ModelRecord };
	onboardingComplete: boolean;
}

export type SystemModelDefaults = Omit<ModelDefaults, "onboardingComplete">;

export class ModelRegistry {
	constructor(
		private readonly systemDb: AppDatabase,
		private readonly companionDb: AppDatabase,
		private readonly invalidations: InvalidationHub,
		private readonly appSettings: AppSettingsStore,
		private readonly forEachCompanionDatabase: (visit: (database: AppDatabase) => void) => void,
	) {}

	list(): ModelRecord[] {
		return this.systemDb
			.select()
			.from(configuredModels)
			.orderBy(asc(configuredModels.createdAt))
			.all()
			.map(toRecord);
	}

	private upsert(
		input: {
			providerId: string;
			modelId: string;
			label: string;
			supportsImages: boolean;
		},
		publish: boolean,
	): ModelRecord {
		const existing = this.get(input.providerId, input.modelId);
		if (
			existing &&
			existing.label === input.label &&
			existing.supportsImages === input.supportsImages
		)
			return existing;
		this.systemDb
			.insert(configuredModels)
			.values({
				providerId: input.providerId,
				modelId: input.modelId,
				label: input.label,
				supportsImages: input.supportsImages ? 1 : 0,
			})
			.onConflictDoUpdate({
				target: [configuredModels.providerId, configuredModels.modelId],
				set: { label: input.label, supportsImages: input.supportsImages ? 1 : 0 },
			})
			.run();
		const model = this.get(input.providerId, input.modelId);
		if (!model) throw new Error("configured model was not persisted");
		if (publish) {
			this.invalidations.invalidate(CacheKey.modelPool());
		}
		return model;
	}

	/** Reproject an added Provider catalog without emitting a refresh-triggering event. */
	sync(input: {
		providerId: string;
		modelId: string;
		label: string;
		supportsImages: boolean;
	}): ModelRecord {
		return this.upsert(input, false);
	}

	enable(input: {
		providerId: string;
		modelId: string;
		label: string;
		supportsImages: boolean;
	}): ModelRecord {
		return this.upsert(input, true);
	}

	disable(providerId: string, modelId: string): void {
		// These databases cannot share a transaction. Clear this companion's
		// references first so a failed system delete never leaves a dangling route.
		let companionChanges = 0;
		this.forEachCompanionDatabase((database) => {
			companionChanges += Number(
				database
					.update(modelRouteSettings)
					.set({
						textProviderId: null,
						textModelId: null,
						onboardingComplete: 0,
						updatedAt: sql`datetime('now')`,
					})
					.where(
						and(
							eq(modelRouteSettings.textProviderId, providerId),
							eq(modelRouteSettings.textModelId, modelId),
						),
					)
					.run().changes,
			);
			companionChanges += Number(
				database
					.update(modelRouteSettings)
					.set({
						visionMode: "auto",
						multimodalProviderId: null,
						multimodalModelId: null,
						updatedAt: sql`datetime('now')`,
					})
					.where(
						and(
							eq(modelRouteSettings.multimodalProviderId, providerId),
							eq(modelRouteSettings.multimodalModelId, modelId),
						),
					)
					.run().changes,
			);
		});
		const currentSystemDefaults = this.appSettings.load().systemModelDefaults;
		const replyDisabled = routeEquals(currentSystemDefaults.reply, providerId, modelId);
		const visionDisabled =
			currentSystemDefaults.vision.mode === "manual" &&
			routeEquals(currentSystemDefaults.vision.route, providerId, modelId);
		const nextSystemDefaults: StoredSystemModelDefaults = {
			...(replyDisabled || !currentSystemDefaults.reply
				? {}
				: { reply: currentSystemDefaults.reply }),
			vision: visionDisabled ? { mode: "auto" } : currentSystemDefaults.vision,
		};
		const removed = this.systemDb.transaction((transaction) => {
			if (replyDisabled || visionDisabled) {
				transaction
					.update(appSettings)
					.set({
						systemModelDefaultsJson: JSON.stringify(nextSystemDefaults),
						...(replyDisabled ? { firstRunStage: "model" } : {}),
						updatedAt: sql`datetime('now')`,
					})
					.where(eq(appSettings.id, 1))
					.run();
			}
			return transaction
				.delete(configuredModels)
				.where(
					and(eq(configuredModels.providerId, providerId), eq(configuredModels.modelId, modelId)),
				)
				.run();
		});
		if (companionChanges || removed.changes) {
			this.invalidations.invalidate(CacheKey.modelPool(), CacheKey.systemModelDefaults());
		}
	}

	systemDefaults(): SystemModelDefaults {
		const stored = this.appSettings.load().systemModelDefaults;
		const reply = stored.reply
			? this.get(stored.reply.providerId, stored.reply.modelId)
			: undefined;
		const vision =
			stored.vision.mode === "manual"
				? this.get(stored.vision.route.providerId, stored.vision.route.modelId)
				: undefined;
		return {
			...(reply ? { reply } : {}),
			vision:
				stored.vision.mode === "manual" && vision?.supportsImages
					? { mode: "manual", route: vision }
					: { mode: "auto" },
		};
	}

	setSystemDefaults(value: {
		reply: { providerId: string; modelId: string };
		vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } };
	}): SystemModelDefaults {
		const reply = this.get(value.reply.providerId, value.reply.modelId);
		if (!reply) throw { kind: "not_found", reason: "configured_model_not_found" };
		const vision =
			value.vision.mode === "manual"
				? this.get(value.vision.route.providerId, value.vision.route.modelId)
				: undefined;
		if (value.vision.mode === "manual" && !vision)
			throw { kind: "not_found", reason: "configured_model_not_found" };
		if (vision && !vision.supportsImages)
			throw { kind: "invalid_request", reason: "model_does_not_support_images" };
		this.appSettings.saveSystemModelDefaults({
			reply: value.reply,
			vision: value.vision,
		});
		this.invalidations.invalidate(CacheKey.systemModelDefaults());
		return this.systemDefaults();
	}

	seedFromSystemDefaults(
		companionId: string,
	): "seeded" | "already_seeded" | "missing_system_default" {
		const existing = this.companionDb
			.select({ companionId: modelRouteSettings.companionId })
			.from(modelRouteSettings)
			.where(eq(modelRouteSettings.companionId, companionId))
			.get();
		if (existing) return "already_seeded";
		const defaults = this.systemDefaults();
		if (!defaults.reply) return "missing_system_default";
		this.companionDb
			.insert(modelRouteSettings)
			.values({
				companionId,
				textProviderId: defaults.reply.providerId,
				textModelId: defaults.reply.modelId,
				visionMode: defaults.vision.mode,
				multimodalProviderId:
					defaults.vision.mode === "manual" ? defaults.vision.route.providerId : null,
				multimodalModelId: defaults.vision.mode === "manual" ? defaults.vision.route.modelId : null,
				onboardingComplete: 0,
			})
			.run();
		this.invalidations.invalidate(CacheKey.modelDefaults());
		return "seeded";
	}

	defaults(companionId: string): ModelDefaults {
		const row = this.companionDb
			.select()
			.from(modelRouteSettings)
			.where(eq(modelRouteSettings.companionId, companionId))
			.get();
		const reply =
			row?.textProviderId && row.textModelId
				? this.get(row.textProviderId, row.textModelId)
				: undefined;
		const manualVision =
			row?.visionMode === "manual" && row.multimodalProviderId && row.multimodalModelId
				? this.get(row.multimodalProviderId, row.multimodalModelId)
				: undefined;
		return {
			...(reply ? { reply } : {}),
			vision:
				manualVision?.supportsImages === true
					? { mode: "manual", route: manualVision }
					: { mode: "auto" },
			onboardingComplete: row?.onboardingComplete === 1 && reply !== undefined,
		};
	}

	setDefaultReply(
		companionId: string,
		route: { providerId: string; modelId: string } | null,
	): ModelDefaults {
		const model = route ? this.get(route.providerId, route.modelId) : undefined;
		if (route && !model) throw { kind: "not_found", reason: "configured_model_not_found" };
		this.companionDb
			.insert(modelRouteSettings)
			.values({
				companionId,
				textProviderId: model?.providerId ?? null,
				textModelId: model?.modelId ?? null,
				...(model ? {} : { onboardingComplete: 0 }),
			})
			.onConflictDoUpdate({
				target: modelRouteSettings.companionId,
				set: {
					textProviderId: model?.providerId ?? null,
					textModelId: model?.modelId ?? null,
					...(model ? {} : { onboardingComplete: 0 }),
					updatedAt: sql`datetime('now')`,
				},
			})
			.run();
		this.invalidations.invalidate(CacheKey.modelDefaults());
		return this.defaults(companionId);
	}

	completeOnboarding(companionId: string): ModelDefaults {
		const defaults = this.defaults(companionId);
		if (!defaults.reply) throw { kind: "unavailable", reason: "character_default_model_required" };
		const updated = this.companionDb
			.update(modelRouteSettings)
			.set({ onboardingComplete: 1, updatedAt: sql`datetime('now')` })
			.where(eq(modelRouteSettings.companionId, companionId))
			.run();
		if (!updated.changes) throw { kind: "unavailable", reason: "character_default_model_required" };
		this.invalidations.invalidate(CacheKey.modelDefaults());
		return this.defaults(companionId);
	}

	setVisionDefault(
		companionId: string,
		value: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } },
	): ModelDefaults {
		const model =
			value.mode === "manual" ? this.get(value.route.providerId, value.route.modelId) : undefined;
		if (value.mode === "manual" && !model)
			throw { kind: "not_found", reason: "configured_model_not_found" };
		if (model && !model.supportsImages)
			throw { kind: "invalid_request", reason: "model_does_not_support_images" };
		this.companionDb
			.insert(modelRouteSettings)
			.values({
				companionId,
				visionMode: value.mode,
				multimodalProviderId: model?.providerId ?? null,
				multimodalModelId: model?.modelId ?? null,
			})
			.onConflictDoUpdate({
				target: modelRouteSettings.companionId,
				set: {
					visionMode: value.mode,
					multimodalProviderId: model?.providerId ?? null,
					multimodalModelId: model?.modelId ?? null,
					updatedAt: sql`datetime('now')`,
				},
			})
			.run();
		this.invalidations.invalidate(CacheKey.modelDefaults());
		return this.defaults(companionId);
	}

	multimodalFallback(): ModelRecord | undefined {
		const vision = this.systemDefaults().vision;
		return vision.mode === "manual" ? vision.route : undefined;
	}

	get(providerId: string, modelId: string): ModelRecord | undefined {
		const row = this.systemDb
			.select()
			.from(configuredModels)
			.where(
				and(eq(configuredModels.providerId, providerId), eq(configuredModels.modelId, modelId)),
			)
			.get();
		return row ? toRecord(row) : undefined;
	}
}

function routeEquals(
	route: { providerId: string; modelId: string } | undefined,
	providerId: string,
	modelId: string,
): boolean {
	return route?.providerId === providerId && route.modelId === modelId;
}

function toRecord(row: typeof configuredModels.$inferSelect): ModelRecord {
	return {
		providerId: row.providerId,
		modelId: row.modelId,
		label: row.label,
		supportsImages: row.supportsImages === 1,
		createdAt: row.createdAt,
	};
}
