import { z } from "zod";

export { z };
export type Schema = z.ZodType;
export type Infer<T extends Schema> = z.infer<T>;

export function toJsonSchema(schema: Schema): Record<string, unknown> {
	return z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
}

export const ModelRouteSchema = z.object({ providerId: z.string(), modelId: z.string() });
export const SettingsDataSchema = z.object({
	relationshipMemoryEnabled: z.boolean(),
	textFallback: ModelRouteSchema.optional(),
	multimodalFallback: ModelRouteSchema.optional(),
});
export const SettingsResponseSchema = z.object({ settings: SettingsDataSchema });

export const ProviderListSchema = z.object({
	providers: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			authType: z.enum(["api_key", "oauth"]),
			credentialStatus: z.enum([
				"missing",
				"session_only",
				"stored",
				"weak_storage",
				"refreshing",
				"invalid",
				"unavailable",
			]),
			availableModels: z.array(
				z.object({ id: z.string(), name: z.string(), supportsImages: z.boolean() }),
			),
		}),
	),
});

export const VoiceListSchema = z.object({
	stacks: z.array(
		z.object({
			id: z.string(),
			providerId: z.string(),
			modelId: z.string(),
			revision: z.number(),
			label: z.string(),
			active: z.boolean(),
			createdAt: z.string(),
		}),
	),
});
