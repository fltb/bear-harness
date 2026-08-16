import { and, asc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import { configuredModels, conversationModelSelections } from "../storage/schema.js";

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
		this.db
			.delete(configuredModels)
			.where(
				and(eq(configuredModels.providerId, providerId), eq(configuredModels.modelId, modelId)),
			)
			.run();
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
		return this.list().find((model) => model.supportsImages);
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
