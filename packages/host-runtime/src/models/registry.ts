import { CacheKey } from "@bear-harness/protocol/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import type {
	AppSettingsStore,
	SystemModelDefaults as StoredSystemModelDefaults,
} from "../storage/app-settings-store.js";
import type { AppDatabase } from "../storage/database.js";
import type { InvalidationHub } from "../storage/invalidation-hub.js";
import {
	appSettings,
	configuredModels,
	modelRouteSettings,
	providerRemovalJournal,
} from "../storage/schema.js";

export type ModelReadiness =
	| "ready"
	| "disabled"
	| "catalog_missing"
	| "provider_auth_required"
	| "provider_removing";

export interface ModelProjectionFacts {
	providers: readonly {
		providerId: string;
		providerName: string;
		authenticated: boolean;
	}[];
	catalogModels: readonly { providerId: string; modelId: string }[];
	removingProviderIds: readonly string[];
}

export interface ModelRecord {
	providerId: string;
	providerName?: string;
	modelId: string;
	label: string;
	supportsImages: boolean;
	enabled: boolean;
	readiness: ModelReadiness;
	createdAt: string;
}

type StoredModelRecord = Omit<ModelRecord, "providerName" | "readiness">;

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

	list(facts: ModelProjectionFacts): ModelRecord[] {
		const project = this.projector(facts);
		return this.systemDb
			.select()
			.from(configuredModels)
			.orderBy(
				asc(configuredModels.createdAt),
				asc(configuredModels.providerId),
				asc(configuredModels.modelId),
			)
			.all()
			.map(toStoredRecord)
			.map(project);
	}

	private upsert(
		input: {
			providerId: string;
			modelId: string;
			label: string;
			supportsImages: boolean;
		},
		options: { publish: boolean; enable: boolean },
	): StoredModelRecord {
		const existing = this.getStored(input.providerId, input.modelId);
		if (
			existing &&
			existing.label === input.label &&
			existing.supportsImages === input.supportsImages &&
			(!options.enable || existing.enabled)
		)
			return existing;
		this.systemDb
			.insert(configuredModels)
			.values({
				providerId: input.providerId,
				modelId: input.modelId,
				label: input.label,
				supportsImages: input.supportsImages ? 1 : 0,
				enabled: 1,
			})
			.onConflictDoUpdate({
				target: [configuredModels.providerId, configuredModels.modelId],
				set: {
					label: input.label,
					supportsImages: input.supportsImages ? 1 : 0,
					...(options.enable ? { enabled: 1 } : {}),
				},
			})
			.run();
		const model = this.getStored(input.providerId, input.modelId);
		if (!model) throw new Error("configured model was not persisted");
		if (options.publish) this.invalidations.invalidate(CacheKey.modelPool());
		return model;
	}

	/** Reproject provider metadata without re-enabling an explicitly disabled route. */
	sync(
		input: {
			providerId: string;
			modelId: string;
			label: string;
			supportsImages: boolean;
		},
		facts: ModelProjectionFacts,
	): ModelRecord {
		return this.projector(facts)(this.upsert(input, { publish: false, enable: false }));
	}

	enable(
		input: {
			providerId: string;
			modelId: string;
			label: string;
			supportsImages: boolean;
		},
		facts: ModelProjectionFacts,
	): ModelRecord {
		const candidate: StoredModelRecord = {
			...input,
			enabled: true,
			createdAt: this.getStored(input.providerId, input.modelId)?.createdAt ?? "",
		};
		this.requireReady(this.projector(facts)(candidate));
		return this.projector(facts)(this.upsert(input, { publish: true, enable: true }));
	}

	disable(providerId: string, modelId: string): void {
		const companionChanges = this.clearCompanionModelReferences(providerId, modelId);
		const currentSystemDefaults = this.appSettings.load().systemModelDefaults;
		const clearsSystemDefaults =
			routeEquals(currentSystemDefaults.reply, providerId, modelId) ||
			(currentSystemDefaults.vision.mode === "manual" &&
				routeEquals(currentSystemDefaults.vision.route, providerId, modelId));
		const result = this.systemDb.transaction((transaction) => {
			if (clearsSystemDefaults) {
				transaction
					.update(appSettings)
					.set({
						systemModelDefaultsJson: JSON.stringify(emptySystemDefaults()),
						systemModelOnboardingComplete: 0,
						updatedAt: sql`datetime('now')`,
					})
					.where(eq(appSettings.id, 1))
					.run();
			}
			return transaction
				.update(configuredModels)
				.set({ enabled: 0 })
				.where(
					and(eq(configuredModels.providerId, providerId), eq(configuredModels.modelId, modelId)),
				)
				.run();
		});
		if (companionChanges || result.changes || clearsSystemDefaults) {
			this.invalidations.invalidate(
				CacheKey.modelPool(),
				CacheKey.modelDefaults(),
				CacheKey.systemModelDefaults(),
			);
		}
	}

	prepareProviderRemoval(providerId: string): void {
		const currentSystemDefaults = this.appSettings.load().systemModelDefaults;
		const clearsSystemDefaults =
			currentSystemDefaults.reply?.providerId === providerId ||
			(currentSystemDefaults.vision.mode === "manual" &&
				currentSystemDefaults.vision.route.providerId === providerId);
		const result = this.systemDb.transaction((transaction) => {
			transaction.insert(providerRemovalJournal).values({ providerId }).onConflictDoNothing().run();
			if (clearsSystemDefaults) {
				transaction
					.update(appSettings)
					.set({
						systemModelDefaultsJson: JSON.stringify(emptySystemDefaults()),
						systemModelOnboardingComplete: 0,
						updatedAt: sql`datetime('now')`,
					})
					.where(eq(appSettings.id, 1))
					.run();
			}
			return transaction
				.update(configuredModels)
				.set({ enabled: 0 })
				.where(eq(configuredModels.providerId, providerId))
				.run();
		});
		const companionChanges = this.clearCompanionProviderReferences(providerId);
		if (result.changes || companionChanges || clearsSystemDefaults) {
			this.invalidations.invalidate(
				CacheKey.modelPool(),
				CacheKey.modelDefaults(),
				CacheKey.systemModelDefaults(),
			);
		}
	}

	finalizeProviderRemoval(providerId: string): void {
		const removed = this.systemDb
			.delete(providerRemovalJournal)
			.where(eq(providerRemovalJournal.providerId, providerId))
			.run();
		if (removed.changes) this.invalidations.invalidate(CacheKey.modelPool());
	}

	listPendingProviderRemovalIds(): string[] {
		return this.systemDb
			.select({ providerId: providerRemovalJournal.providerId })
			.from(providerRemovalJournal)
			.orderBy(asc(providerRemovalJournal.providerId))
			.all()
			.map(({ providerId }) => providerId);
	}

	systemDefaults(facts: ModelProjectionFacts): SystemModelDefaults {
		const stored = this.appSettings.load().systemModelDefaults;
		const reply = stored.reply
			? this.get(stored.reply.providerId, stored.reply.modelId, facts)
			: undefined;
		const vision =
			stored.vision.mode === "manual" && reply?.supportsImages !== true
				? this.get(stored.vision.route.providerId, stored.vision.route.modelId, facts)
				: undefined;
		return {
			...(reply ? { reply } : {}),
			vision: vision?.supportsImages ? { mode: "manual", route: vision } : { mode: "auto" },
		};
	}

	setSystemDefaults(
		value: {
			reply: { providerId: string; modelId: string };
			vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } };
		},
		facts: ModelProjectionFacts,
	): SystemModelDefaults {
		this.validateSystemDefaults(value, facts);
		this.appSettings.saveSystemModelDefaults(value);
		this.invalidations.invalidate(CacheKey.systemModelDefaults());
		return this.systemDefaults(facts);
	}

	completeSystemModelOnboarding(
		value: {
			reply: { providerId: string; modelId: string };
			vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } };
		},
		facts: ModelProjectionFacts,
	): SystemModelDefaults {
		this.validateSystemDefaults(value, facts);
		this.appSettings.completeSystemModelOnboarding(value);
		this.invalidations.invalidate(CacheKey.systemModelDefaults(), CacheKey.settings());
		return this.systemDefaults(facts);
	}

	seedFromSystemDefaults(
		companionId: string,
		facts: ModelProjectionFacts,
	): "seeded" | "already_seeded" | "missing_system_default" {
		const existing = this.companionDb
			.select({ companionId: modelRouteSettings.companionId })
			.from(modelRouteSettings)
			.where(eq(modelRouteSettings.companionId, companionId))
			.get();
		if (existing) return "already_seeded";
		const defaults = this.systemDefaults(facts);
		if (defaults.reply?.readiness !== "ready") return "missing_system_default";
		const vision =
			defaults.vision.mode === "manual" && defaults.vision.route.readiness === "ready"
				? defaults.vision
				: { mode: "auto" as const };
		this.companionDb
			.insert(modelRouteSettings)
			.values({
				companionId,
				textProviderId: defaults.reply.providerId,
				textModelId: defaults.reply.modelId,
				visionMode: vision.mode,
				multimodalProviderId: vision.mode === "manual" ? vision.route.providerId : null,
				multimodalModelId: vision.mode === "manual" ? vision.route.modelId : null,
				onboardingComplete: 0,
			})
			.run();
		this.invalidations.invalidate(CacheKey.modelDefaults());
		return "seeded";
	}

	defaults(companionId: string, facts: ModelProjectionFacts): ModelDefaults {
		const row = this.companionDb
			.select()
			.from(modelRouteSettings)
			.where(eq(modelRouteSettings.companionId, companionId))
			.get();
		const reply =
			row?.textProviderId && row.textModelId
				? this.get(row.textProviderId, row.textModelId, facts)
				: undefined;
		const manualVision =
			row?.visionMode === "manual" &&
			reply?.supportsImages !== true &&
			row.multimodalProviderId &&
			row.multimodalModelId
				? this.get(row.multimodalProviderId, row.multimodalModelId, facts)
				: undefined;
		return {
			...(reply ? { reply } : {}),
			vision:
				manualVision?.supportsImages === true
					? { mode: "manual", route: manualVision }
					: { mode: "auto" },
			onboardingComplete: row?.onboardingComplete === 1 && reply?.readiness === "ready",
		};
	}

	setDefaultReply(
		companionId: string,
		route: { providerId: string; modelId: string } | null,
		facts: ModelProjectionFacts,
	): ModelDefaults {
		const model = route
			? this.requireReady(this.get(route.providerId, route.modelId, facts))
			: undefined;
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
		return this.defaults(companionId, facts);
	}

	completeOnboarding(companionId: string, facts: ModelProjectionFacts): ModelDefaults {
		const defaults = this.defaults(companionId, facts);
		if (!defaults.reply) throw { kind: "unavailable", reason: "character_default_model_required" };
		this.requireReady(defaults.reply);
		const updated = this.companionDb
			.update(modelRouteSettings)
			.set({ onboardingComplete: 1, updatedAt: sql`datetime('now')` })
			.where(eq(modelRouteSettings.companionId, companionId))
			.run();
		if (!updated.changes) throw { kind: "unavailable", reason: "character_default_model_required" };
		this.invalidations.invalidate(CacheKey.modelDefaults());
		return this.defaults(companionId, facts);
	}

	setVisionDefault(
		companionId: string,
		value: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } },
		facts: ModelProjectionFacts,
	): ModelDefaults {
		const model =
			value.mode === "manual"
				? this.requireReady(this.get(value.route.providerId, value.route.modelId, facts))
				: undefined;
		const reply = this.defaults(companionId, facts).reply;
		if (model && !model.supportsImages)
			throw { kind: "invalid_request", reason: "model_does_not_support_images" };
		if (model && reply?.supportsImages)
			throw { kind: "invalid_request", reason: "reply_model_handles_images" };
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
		return this.defaults(companionId, facts);
	}

	multimodalFallback(facts: ModelProjectionFacts): ModelRecord | undefined {
		const vision = this.systemDefaults(facts).vision;
		return vision.mode === "manual" && vision.route.readiness === "ready"
			? vision.route
			: undefined;
	}

	get(providerId: string, modelId: string, facts: ModelProjectionFacts): ModelRecord | undefined {
		const stored = this.getStored(providerId, modelId);
		return stored ? this.projector(facts)(stored) : undefined;
	}

	private getStored(providerId: string, modelId: string): StoredModelRecord | undefined {
		const row = this.systemDb
			.select()
			.from(configuredModels)
			.where(
				and(eq(configuredModels.providerId, providerId), eq(configuredModels.modelId, modelId)),
			)
			.get();
		return row ? toStoredRecord(row) : undefined;
	}

	private projector(facts: ModelProjectionFacts): (model: StoredModelRecord) => ModelRecord {
		const providers = new Map(facts.providers.map((provider) => [provider.providerId, provider]));
		const catalogModels = new Set(
			facts.catalogModels.map(({ providerId, modelId }) => modelKey(providerId, modelId)),
		);
		const removingProviders = new Set([
			...facts.removingProviderIds,
			...this.listPendingProviderRemovalIds(),
		]);
		return (model) => {
			const provider = providers.get(model.providerId);
			const readiness: ModelReadiness = removingProviders.has(model.providerId)
				? "provider_removing"
				: !model.enabled
					? "disabled"
					: !catalogModels.has(modelKey(model.providerId, model.modelId))
						? "catalog_missing"
						: !provider?.authenticated
							? "provider_auth_required"
							: "ready";
			return {
				...model,
				...(provider ? { providerName: provider.providerName } : {}),
				readiness,
			};
		};
	}

	private validateSystemDefaults(
		value: {
			reply: { providerId: string; modelId: string };
			vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } };
		},
		facts: ModelProjectionFacts,
	): void {
		const reply = this.requireReady(this.get(value.reply.providerId, value.reply.modelId, facts));
		const vision =
			value.vision.mode === "manual"
				? this.requireReady(
						this.get(value.vision.route.providerId, value.vision.route.modelId, facts),
					)
				: undefined;
		if (vision && !vision.supportsImages)
			throw { kind: "invalid_request", reason: "model_does_not_support_images" };
		if (vision && reply.supportsImages)
			throw { kind: "invalid_request", reason: "reply_model_handles_images" };
	}

	private requireReady(model: ModelRecord | undefined): ModelRecord {
		if (!model) throw { kind: "not_found", reason: "configured_model_not_found" };
		if (model.readiness !== "ready") {
			throw {
				kind: "unavailable",
				reason: "configured_model_not_ready",
				details: {
					providerId: model.providerId,
					modelId: model.modelId,
					readiness: model.readiness,
				},
			};
		}
		return model;
	}

	private clearCompanionModelReferences(providerId: string, modelId: string): number {
		let changes = 0;
		this.forEachCompanionDatabase((database) => {
			changes += Number(
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
			changes += Number(
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
		return changes;
	}

	private clearCompanionProviderReferences(providerId: string): number {
		let changes = 0;
		this.forEachCompanionDatabase((database) => {
			changes += Number(
				database
					.update(modelRouteSettings)
					.set({
						textProviderId: null,
						textModelId: null,
						onboardingComplete: 0,
						updatedAt: sql`datetime('now')`,
					})
					.where(eq(modelRouteSettings.textProviderId, providerId))
					.run().changes,
			);
			changes += Number(
				database
					.update(modelRouteSettings)
					.set({
						visionMode: "auto",
						multimodalProviderId: null,
						multimodalModelId: null,
						updatedAt: sql`datetime('now')`,
					})
					.where(eq(modelRouteSettings.multimodalProviderId, providerId))
					.run().changes,
			);
		});
		return changes;
	}
}

function routeEquals(
	route: { providerId: string; modelId: string } | undefined,
	providerId: string,
	modelId: string,
): boolean {
	return route?.providerId === providerId && route.modelId === modelId;
}

function emptySystemDefaults(): StoredSystemModelDefaults {
	return { vision: { mode: "auto" } };
}

function modelKey(providerId: string, modelId: string): string {
	return `${providerId}\0${modelId}`;
}

function toStoredRecord(row: typeof configuredModels.$inferSelect): StoredModelRecord {
	return {
		providerId: row.providerId,
		modelId: row.modelId,
		label: row.label,
		supportsImages: row.supportsImages === 1,
		enabled: row.enabled === 1,
		createdAt: row.createdAt,
	};
}
