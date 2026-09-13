import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, ".local-content");
const manifest = JSON.parse(await readFile(resolve(source, "media-manifest.json"), "utf8"));
// Validate the retained private frozen assets. Never load mutable character packages.
for (const entry of Object.values(manifest.files)) {
	const file = resolve(source, entry.url);
	if (!file.startsWith(source + sep) || !entry.url.startsWith("media/"))
		throw new Error(`Invalid frozen path: ${entry.url}`);
	const bytes = await readFile(file);
	if (
		bytes.length !== entry.bytes ||
		createHash("sha256").update(bytes).digest("hex") !== entry.sha256
	)
		throw new Error(`Frozen media integrity failure: ${entry.url}`);
}
console.log(
	`Verified ${Object.keys(manifest.files).length} frozen media files for PRIVATE LOCAL REVIEW ONLY. RJ/Volibear public rights remain unconfirmed.`,
);
