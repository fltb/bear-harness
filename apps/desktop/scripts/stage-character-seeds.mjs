import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { productConfig } from "@bear-harness/product-config";

const source = resolve(process.cwd(), "../../config/characters");
const destination = resolve(process.cwd(), "dist/character-seeds");
const selected = (process.env.BEAR_PACKAGED_CHARACTER_IDS ?? "")
	.split(",")
	.map((id) => id.trim())
	.filter(Boolean);
const ids = selected.length > 0 ? selected : [productConfig.defaultCharacterId];
const defaultId = process.env.BEAR_DEFAULT_CHARACTER_ID;
if (defaultId && !ids.includes(defaultId)) {
	throw new Error(
		`BEAR_DEFAULT_CHARACTER_ID must be included in BEAR_PACKAGED_CHARACTER_IDS: ${defaultId}`,
	);
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const id of ids) {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
		throw new Error(`Invalid packaged character id: ${id}`);
	const packageRoot = resolve(source, id);
	if (!existsSync(resolve(packageRoot, "character.yaml")))
		throw new Error(`character seed missing: ${id}`);
	cpSync(packageRoot, resolve(destination, id), { recursive: true });
}
