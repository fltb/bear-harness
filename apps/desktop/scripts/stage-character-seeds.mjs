import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve(process.cwd(), "../../config/characters");
const destination = resolve(process.cwd(), "dist/character-seeds");
const selected = (process.env.BEAR_PACKAGED_CHARACTER_IDS ?? "")
	.split(",")
	.map((id) => id.trim())
	.filter(Boolean);
const ids =
	selected.length > 0
		? selected
		: readdirSync(source, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
const defaultId = process.env.BEAR_DEFAULT_CHARACTER_ID;
if (defaultId && !ids.includes(defaultId)) {
	throw new Error(
		`BEAR_DEFAULT_CHARACTER_ID must be included in BEAR_PACKAGED_CHARACTER_IDS: ${defaultId}`,
	);
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const id of ids) {
	const packageRoot = resolve(source, id);
	if (!existsSync(resolve(packageRoot, "character.yaml")))
		throw new Error(`character seed missing: ${id}`);
	cpSync(packageRoot, resolve(destination, id), { recursive: true });
}
