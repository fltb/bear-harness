import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CharacterLoader } from "../packages/host-runtime/dist/companion/character-loader.js";

const root = fileURLToPath(new URL("../config/characters/", import.meta.url));
const loader = new CharacterLoader(root);
for (const entry of readdirSync(root, { withFileTypes: true })) {
	if (entry.isDirectory()) {
		const character = loader.load(entry.name);
		if (!character) throw new Error(`Missing character manifest: ${entry.name}`);
		console.log(`${entry.name}: ${character.canon.sources.length} Canon documents validated`);
	}
}
