import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, ".local-content");
// Explicitly freeze a new local production snapshot; normal runs only verify it.
if (process.argv.includes("--freeze")) {
	const staging = await mkdtemp(resolve(root, ".local-content-stage-"));
	try {
		const script = await readFile(resolve(root, "src/demo/scenario.ts"), "utf8");
		const files = {};
		for (const match of script.matchAll(/"\/local-content\/(media\/[^"\n]+)"/g)) {
			const url = match[1];
			const [, character, ...parts] = url.split("/");
			if (!["jizhou", "rj", "volibear"].includes(character) || parts.includes(".."))
				throw new Error(`Invalid source asset: ${url}`);
			const assets = await realpath(resolve(root, "../../config/characters", character, "assets"));
			const original = await realpath(resolve(assets, ...parts));
			if (!original.startsWith(assets + sep)) throw new Error(`Asset escapes package: ${url}`);
			const bytes = await readFile(original);
			const destination = resolve(staging, url);
			await mkdir(resolve(destination, ".."), { recursive: true });
			await writeFile(destination, bytes);
			files[url] = {
				url,
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
		}
		if (Object.keys(files).length === 0) throw new Error("No production media references found");
		await writeFile(resolve(staging, "media-manifest.json"), JSON.stringify({ files }, null, 2));
		await rename(staging, source);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
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
