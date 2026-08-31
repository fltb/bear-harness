import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parse } from "yaml";

const root = realpathSync(new URL("../config/characters/", import.meta.url));
const failures = [];
const id = /^[a-z][a-z0-9_-]{0,63}$/;
for (const entry of readdirSync(root, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const packageRoot = realpathSync(resolve(root, entry.name));
	const manifestPath = resolve(packageRoot, "canon/manifest.yaml");
	if (!existsSync(manifestPath)) {
		failures.push(`${entry.name}: missing canon/manifest.yaml`);
		continue;
	}
	const manifest = parse(readFileSync(manifestPath, "utf8"));
	if (typeof manifest?.language !== "string")
		failures.push(`${entry.name}: canon manifest requires language`);
	for (const field of ["sources", "entities", "modules"])
		if (!Array.isArray(manifest?.[field]))
			failures.push(`${entry.name}: canon ${field} must be an array`);
	const sourceIds = new Set();
	for (const source of manifest?.sources ?? []) {
		if (!id.test(source?.id ?? "") || sourceIds.has(source.id))
			failures.push(`${entry.name}: invalid or duplicate canon source id`);
		sourceIds.add(source.id);
		if (typeof source.path !== "string" || source.path.split(/[\\/]/).includes(".."))
			failures.push(`${entry.name}: canon source path must stay inside canon/`);
		const path = resolve(packageRoot, "canon", source.path ?? "");
		if (!existsSync(path) || relative(packageRoot, path).startsWith(".."))
			failures.push(`${entry.name}: canon source path is missing or escapes the package`);
	}
	const moduleIds = new Set((manifest?.modules ?? []).map((module) => module.id));
	for (const module of manifest?.modules ?? []) {
		if (!id.test(module?.id ?? "") || (module.parent && !moduleIds.has(module.parent)))
			failures.push(`${entry.name}: invalid canon module id or parent`);
		for (const binding of module.bindings ?? [])
			if (!sourceIds.has(binding.source))
				failures.push(`${entry.name}: canon module ${module.id} binds a missing source`);
	}
}

if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else console.log("Canon package gate passed.");
