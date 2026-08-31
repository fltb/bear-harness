import { z } from "@bear-harness/schema";

const Identifier = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/);
const Copy = z.string().min(1).max(4096);
const AssetPath = z.string().min(1).max(512);

export const CharacterMediaItemSchema = z
	.strictObject({
		id: Identifier,
		kind: z.enum(["image", "animation", "audio", "video"]),
		label: Copy,
		description: Copy,
		use_when: Copy,
		asset: AssetPath,
		poster: AssetPath.optional(),
		captions: AssetPath.optional(),
		loop: z.boolean().default(false),
	})
	.superRefine((media, context) => {
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

export const CharacterMediaSchema = z.array(CharacterMediaItemSchema).max(200);
export type CharacterMediaDefinition = z.infer<typeof CharacterMediaSchema>;

const ANIMATION_EXTENSIONS = new Set([".gif", ".webp", ".apng", ".png"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".flac"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogv"]);

export function mediaAssetExtensions(
	kind: CharacterMediaDefinition[number]["kind"],
): ReadonlySet<string> {
	if (kind === "animation") return ANIMATION_EXTENSIONS;
	if (kind === "image") return IMAGE_EXTENSIONS;
	if (kind === "audio") return AUDIO_EXTENSIONS;
	return VIDEO_EXTENSIONS;
}
