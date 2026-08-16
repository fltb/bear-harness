import { and, asc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import {
	configuredModels,
	conversationModelSelections,
	conversations,
	modelRouteSettings,
} from "../storage/schema.js";

export interface ModelRecord {
	providerId: string;
	modelId: string;
	label: string;
	supportsImages: boolean;
	createdAt: string;
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

	enable(input: {
		providerId: string;
		modelId: string;
		label: string;
		supportsImages: boolean;
	}): ModelRecord {
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
		this.eventBus.publish("model.enabled", {
			providerId: input.providerId,
			modelId: input.modelId,
		});
		return model;
	}

	disable(providerId: string, modelId: string): void {
		const existing = this.get(providerId, modelId);
		if (!existing) throw { kind: "not_found", reason: "configured_model_not_found" };
		this.db.transaction((transaction) => {
			transaction
				.update(modelRouteSettings)
				.set({
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

	select(conversationId: string, providerId: string, modelId: string): ModelRecord {
		const model = this.get(providerId, modelId);
		if (!model) throw { kind: "not_found", reason: "configured_model_not_found" };
		this.db
			.insert(conversationModelSelections)
			.values({ conversationId, providerId, modelId })
			.onConflictDoUpdate({
				target: conversationModelSelections.conversationId,
				set: { providerId, modelId, updatedAt: sql`datetime('now')` },
			})
			.run();
		this.eventBus.publish("model.selected", { conversationId, providerId, modelId });
		return model;
	}

	resolve(conversationId: string, requiresImages: boolean): ModelRecord | undefined {
		const selected = this.selected(conversationId);
		if (!selected) return undefined;
		if (!requiresImages || selected.supportsImages) return selected;
		const companion = this.db
			.select({ id: conversations.companionId })
			.from(conversations)
			.where(eq(conversations.id, conversationId))
			.get();
		return companion ? this.multimodalFallback(companion.id) : undefined;
	}

	multimodalFallback(companionId: string): ModelRecord | undefined {
		const configured = this.db
			.select({
				providerId: modelRouteSettings.multimodalProviderId,
				modelId: modelRouteSettings.multimodalModelId,
			})
			.from(modelRouteSettings)
			.where(eq(modelRouteSettings.companionId, companionId))
			.get();
		if (configured?.providerId && configured.modelId) {
			const model = this.get(configured.providerId, configured.modelId);
			if (model?.supportsImages) return model;
		}
		const automatic = this.list().find((model) => model.supportsImages);
		if (!automatic) return undefined;
		this.setMultimodalFallback(companionId, automatic.providerId, automatic.modelId);
		return automatic;
	}

	setMultimodalFallback(companionId: string, providerId: string, modelId: string): ModelRecord {
		const model = this.get(providerId, modelId);
		if (!model) throw { kind: "not_found", reason: "configured_model_not_found" };
		if (!model.supportsImages) {
			throw { kind: "invalid_request", reason: "model_does_not_support_images" };
		}
		this.db
			.insert(modelRouteSettings)
			.values({ companionId, multimodalProviderId: providerId, multimodalModelId: modelId })
			.onConflictDoUpdate({
				target: modelRouteSettings.companionId,
				set: {
					multimodalProviderId: providerId,
					multimodalModelId: modelId,
					updatedAt: sql`datetime('now')`,
				},
			})
			.run();
		this.eventBus.publish("model.multimodal_fallback_selected", { providerId, modelId });
		return model;
	}

	selected(conversationId: string): ModelRecord | undefined {
		const row = this.db
			.select({
				providerId: configuredModels.providerId,
				modelId: configuredModels.modelId,
				label: configuredModels.label,
				supportsImages: configuredModels.supportsImages,
				createdAt: configuredModels.createdAt,
			})
			.from(conversationModelSelections)
			.innerJoin(
				configuredModels,
				and(
					eq(configuredModels.providerId, conversationModelSelections.providerId),
					eq(configuredModels.modelId, conversationModelSelections.modelId),
				),
			)
			.where(eq(conversationModelSelections.conversationId, conversationId))
			.get();
		return row ? toRecord(row) : undefined;
	}

	private get(providerId: string, modelId: string): ModelRecord | undefined {
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
