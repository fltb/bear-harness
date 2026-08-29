import { z } from "@bear-harness/schema";

const Identifier = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/);
const Copy = z.string().min(1).max(4096);
const AssetPath = z.string().min(1).max(512);
const StatePath = z
	.string()
	.min(1)
	.max(512)
	.regex(/^\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/u);

export const RoleplayValueSchema = z.union([
	z.string().max(4096),
	z.number().finite(),
	z.boolean(),
]);
export type RoleplayValue = z.infer<typeof RoleplayValueSchema>;

export type RoleplayCondition =
	| { all: RoleplayCondition[] }
	| { any: RoleplayCondition[] }
	| { not: RoleplayCondition }
	| { variable: string; equals: RoleplayValue }
	| { variable: string; operator: "gt" | "gte" | "lt" | "lte"; value: number }
	| { state: string; equals: RoleplayValue | string[] }
	| { state: string; operator: "gt" | "gte" | "lt" | "lte"; value: number }
	| { unlocked: string };

export const RoleplayConditionSchema: z.ZodType<RoleplayCondition> = z.lazy(() =>
	z.union([
		z.strictObject({ all: z.array(RoleplayConditionSchema).min(1).max(20) }),
		z.strictObject({ any: z.array(RoleplayConditionSchema).min(1).max(20) }),
		z.strictObject({ not: RoleplayConditionSchema }),
		z.strictObject({ variable: Identifier, equals: RoleplayValueSchema }),
		z.strictObject({
			state: StatePath,
			equals: z.union([RoleplayValueSchema, z.array(z.string().max(4096)).max(100)]),
		}),
		z.strictObject({
			variable: Identifier,
			operator: z.enum(["gt", "gte", "lt", "lte"]),
			value: z.number().finite(),
		}),
		z.strictObject({
			state: StatePath,
			operator: z.enum(["gt", "gte", "lt", "lte"]),
			value: z.number().finite(),
		}),
		z.strictObject({ unlocked: Identifier }),
	]),
);

export const RoleplayEffectSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("state"),
		path: StatePath,
		op: z.enum(["add", "replace", "remove"]),
		value: z.union([RoleplayValueSchema, z.array(z.string().max(4096)).max(100)]).optional(),
		authority: z.enum(["user_choice", "host_event"]),
	}),
	z.strictObject({ type: z.literal("set"), variable: Identifier, value: RoleplayValueSchema }),
	z.strictObject({ type: z.literal("increment"), variable: Identifier, by: z.number().finite() }),
	z.strictObject({ type: z.literal("unlock"), unlockable: Identifier }),
	z.strictObject({ type: z.literal("scene"), scene: Identifier }),
	z.strictObject({ type: z.literal("expression"), expression: Identifier }),
	z.strictObject({ type: z.literal("media"), media: Identifier }),
]);
export type RoleplayEffect = z.infer<typeof RoleplayEffectSchema>;

const RoleplayMediaSchema = z
	.strictObject({
		id: Identifier,
		kind: z.enum(["image", "animation", "audio", "video"]),
		label: Copy,
		asset: AssetPath,
		presentation: z.enum(["dialog", "inline", "ambient"]).default("dialog"),
		poster: AssetPath.optional(),
		captions: AssetPath.optional(),
		loop: z.boolean().default(false),
		when: RoleplayConditionSchema.optional(),
	})
	.superRefine((media, context) => {
		if (media.presentation === "ambient" && media.kind !== "audio")
			context.addIssue({
				code: "custom",
				path: ["presentation"],
				message: "ambient media presentation is only valid for audio",
			});
		if (media.kind === "animation" && !media.poster)
			context.addIssue({
				code: "custom",
				path: ["poster"],
				message: "animated media requires a reduced-motion poster",
			});
		if ((media.kind === "audio" || media.kind === "video") && !media.captions)
			context.addIssue({
				code: "custom",
				path: ["captions"],
				message: "audio and video media require WebVTT captions",
			});
	});

export const RoleplaySchema = z.strictObject({
	variables: z
		.array(
			z.strictObject({
				id: Identifier,
				type: z.enum(["number", "boolean", "enum", "string"]),
				scope: z.enum(["conversation", "relationship", "character"]),
				initial: RoleplayValueSchema,
				display: z.discriminatedUnion("kind", [
					z.strictObject({ kind: z.literal("hidden") }),
					z.strictObject({ kind: z.literal("exact"), label: Copy }),
					z.strictObject({
						kind: z.literal("level"),
						label: Copy,
						levels: z
							.array(z.strictObject({ min: z.number().finite(), label: Copy }))
							.min(1)
							.max(20),
					}),
				]),
				values: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
			}),
		)
		.max(100),
	media: z.array(RoleplayMediaSchema).max(200),
	unlockables: z
		.array(
			z.strictObject({
				id: Identifier,
				kind: z.enum(["cg", "memory", "music", "video", "achievement"]),
				label: Copy,
				description: z.string().max(4096),
				media: Identifier.optional(),
			}),
		)
		.max(200),
	events: z
		.array(
			z.strictObject({
				id: Identifier,
				label: Copy,
				when: RoleplayConditionSchema.optional(),
				effects: z.array(RoleplayEffectSchema).min(1).max(20),
			}),
		)
		.max(300),
	choice_sets: z
		.array(
			z.strictObject({
				id: Identifier,
				prompt: Copy,
				when: RoleplayConditionSchema.optional(),
				choices: z
					.array(
						z.union([
							z.strictObject({
								id: Identifier,
								label: Copy,
								description: z.string().max(4096).optional(),
								event: Identifier,
								follow_up: Copy,
							}),
							z.strictObject({
								id: Identifier,
								label: Copy,
								description: z.string().max(4096).optional(),
								message: Copy,
							}),
						]),
					)
					.min(2)
					.max(12),
			}),
		)
		.max(100),
});

export type RoleplayDefinition = z.infer<typeof RoleplaySchema>;

const ANIMATION_EXTENSIONS = new Set([".gif", ".webp", ".apng", ".png"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".flac"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogv"]);

export function roleplayAssetExtensions(
	kind: RoleplayDefinition["media"][number]["kind"],
): ReadonlySet<string> {
	if (kind === "animation") return ANIMATION_EXTENSIONS;
	if (kind === "image") return IMAGE_EXTENSIONS;
	if (kind === "audio") return AUDIO_EXTENSIONS;
	return VIDEO_EXTENSIONS;
}
