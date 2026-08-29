import { z } from "@bear-harness/schema";

const IdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const StateValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const CanonAccessSchema = z
	.strictObject({
		mode: z.enum(["always", "when_asked", "gated"]),
		skill: IdSchema.optional(),
		state: z
			.strictObject({
				path: z.string().min(1).max(160),
				values: z.array(StateValueSchema).min(1).max(30),
			})
			.optional(),
	})
	.superRefine((access, context) => {
		if (access.mode === "gated" && !access.skill && !access.state)
			context.addIssue({
				code: "custom",
				path: ["mode"],
				message: "gated canon requires a Skill or state gate",
			});
		if (access.mode !== "gated" && (access.skill || access.state))
			context.addIssue({
				code: "custom",
				path: ["mode"],
				message: "only gated canon may declare Skill or state gates",
			});
	});

export const CanonPackageManifestSchema = z.strictObject({
	version: z.literal(1),
	language: z.string().min(2).max(35),
	sources: z.array(
		z.strictObject({
			id: IdSchema,
			title: z.string().min(1).max(200),
			path: z
				.string()
				.min(1)
				.max(512)
				.refine(
					(value) =>
						!value.startsWith("/") &&
						!value.startsWith("\\") &&
						!value.split(/[\\/]/).includes(".."),
					"must stay inside the canon directory",
				),
			kind: z.enum(["original_text", "reference"]),
		}),
	),
	entities: z.array(
		z.strictObject({
			id: IdSchema,
			kind: z.string().min(1).max(64),
			name: z.string().min(1).max(200),
			aliases: z.array(z.string().min(1).max(200)).max(40).default([]),
			description: z.string().max(2000).default(""),
		}),
	),
	modules: z.array(
		z.strictObject({
			id: IdSchema,
			parent: IdSchema.optional(),
			kind: z.enum([
				"root",
				"arc",
				"event",
				"entity",
				"relationship",
				"location",
				"object",
				"behavior",
			]),
			title: z.string().min(1).max(200),
			summary: z.string().max(4000).default(""),
			triggers: z.array(z.string().min(1).max(200)).max(40).default([]),
			access: CanonAccessSchema,
			bindings: z
				.array(
					z.strictObject({
						source: IdSchema,
						headings: z.array(z.string().min(1).max(300)).max(20).optional(),
						start_offset: z.number().int().nonnegative().optional(),
						end_offset: z.number().int().positive().optional(),
					}),
				)
				.default([]),
		}),
	),
});

export type CanonPackageManifest = z.infer<typeof CanonPackageManifestSchema>;

export interface LoadedCanonPackage {
	manifest: CanonPackageManifest;
	sources: Array<CanonPackageManifest["sources"][number] & { content: string }>;
}

export function validateCanonManifest(manifest: CanonPackageManifest, characterId: string): void {
	const unique = (values: string[], kind: string): void => {
		if (new Set(values).size !== values.length)
			throw new Error(`character package ${characterId}: duplicate canon ${kind} id`);
	};
	unique(
		manifest.sources.map((entry) => entry.id),
		"source",
	);
	unique(
		manifest.entities.map((entry) => entry.id),
		"entity",
	);
	unique(
		manifest.modules.map((entry) => entry.id),
		"module",
	);
	const sources = new Set(manifest.sources.map((entry) => entry.id));
	const modules = new Set(manifest.modules.map((entry) => entry.id));
	for (const module of manifest.modules) {
		if (module.parent && !modules.has(module.parent))
			throw new Error(`character package ${characterId}: canon module parent is missing`);
		if (module.parent === module.id)
			throw new Error(`character package ${characterId}: canon module cannot parent itself`);
		for (const binding of module.bindings) {
			if (!sources.has(binding.source))
				throw new Error(`character package ${characterId}: canon binding source is missing`);
			if (
				binding.start_offset !== undefined &&
				binding.end_offset !== undefined &&
				binding.end_offset <= binding.start_offset
			)
				throw new Error(`character package ${characterId}: canon binding range is invalid`);
		}
	}
	for (const module of manifest.modules) {
		const visited = new Set<string>([module.id]);
		let parent = module.parent;
		while (parent) {
			if (visited.has(parent))
				throw new Error(`character package ${characterId}: canon module hierarchy has a cycle`);
			visited.add(parent);
			parent = manifest.modules.find((entry) => entry.id === parent)?.parent;
		}
	}
}
