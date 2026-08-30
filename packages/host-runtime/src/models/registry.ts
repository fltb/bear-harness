import { and, asc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import { configuredModels, modelRouteSettings } from "../storage/schema.js";

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
}

export class ModelRegistry {
	constructor(
		private readonly db: AppDatabase,
		private readonly eventBus: EventBus,
	) {}

	list(): ModelRecord[] {
		return this.db
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
		this.db
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
			this.eventBus.publish("model.enabled", {
				providerId: input.providerId,
				modelId: input.modelId,
			});
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
		const existing = this.get(providerId, modelId);
		if (!existing) throw { kind: "not_found", reason: "configured_model_not_found" };
		this.db.transaction((transaction) => {
			transaction
				.update(modelRouteSettings)
				.set({
					textProviderId: null,
					textModelId: null,
					updatedAt: sql`datetime('now')`,
				})
				.where(
					and(
						eq(modelRouteSettings.textProviderId, providerId),
						eq(modelRouteSettings.textModelId, modelId),
					),
				)
				.run();
			transaction
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
				.run();
			transaction
				.delete(configuredModels)
				.where(
					and(eq(configuredModels.providerId, providerId), eq(configuredModels.modelId, modelId)),
				)
				.run();
		});
		this.eventBus.publish("model.disabled", { providerId, modelId });
	}

	defaults(companionId: string): ModelDefaults {
		const row = this.db
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
		};
	}

	setDefaultReply(
		companionId: string,
		route: { providerId: string; modelId: string } | null,
	): ModelDefaults {
		const model = route ? this.get(route.providerId, route.modelId) : undefined;
		if (route && !model) throw { kind: "not_found", reason: "configured_model_not_found" };
		this.db
			.insert(modelRouteSettings)
			.values({
				companionId,
				textProviderId: model?.providerId ?? null,
				textModelId: model?.modelId ?? null,
			})
			.onConflictDoUpdate({
				target: modelRouteSettings.companionId,
				set: {
					textProviderId: model?.providerId ?? null,
					textModelId: model?.modelId ?? null,
					updatedAt: sql`datetime('now')`,
				},
			})
			.run();
		this.eventBus.publish("model.defaults_changed", { kind: "reply" });
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
		this.db
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
		this.eventBus.publish("model.defaults_changed", { kind: "vision" });
		return this.defaults(companionId);
	}

	multimodalFallback(companionId: string): ModelRecord | undefined {
		const vision = this.defaults(companionId).vision;
		return vision.mode === "manual" ? vision.route : undefined;
	}

	get(providerId: string, modelId: string): ModelRecord | undefined {
		const row = this.db
			.select()
			.from(configuredModels)
			.where(
				and(eq(configuredModels.providerId, providerId), eq(configuredModels.modelId, modelId)),
			)
			.get();
		return row ? toRecord(row) : undefined;
	}
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
