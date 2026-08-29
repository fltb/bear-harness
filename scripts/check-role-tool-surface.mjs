import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const allowedHostTools = new Set([
	"host_state",
	"host_visual",
	"host_present",
	"host_history",
	"host_canon",
	"host_memory",
	"host_attachment",
	"host_delegate",
]);
const retired = [
	"host_get_state",
	"host_set_scene",
	"host_set_expression",
	"host_get_roleplay_state",
	"host_trigger_roleplay_event",
	"host_play_media",
	"host_present_choices",
	"host_search_conversation_history",
	"host_search_canon",
	"host_remember",
	"host_list_attachments",
	"host_read_attachment",
	"host_delegate_agent",
];
const failures = [];
const roots = ["packages/host-runtime/src", "packages/companion-ui/src", "config/characters"];

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : [path];
	});
}

for (const root of roots) {
	for (const file of sourceFiles(root)) {
		if (!/\.(?:ts|tsx|js|mjs|yaml|md)$/.test(file)) continue;
		const source = readFileSync(file, "utf8");
		for (const name of retired)
			if (source.includes(name)) failures.push(`${file}: retired model tool ${name}`);
	}
}

const characterRoot = resolve("config/characters");
for (const entry of readdirSync(characterRoot, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const packageRoot = resolve(characterRoot, entry.name);
	const manifestPath = resolve(packageRoot, "character.yaml");
	if (!existsSync(manifestPath)) continue;
	const manifest = parse(readFileSync(manifestPath, "utf8"));
	const fields = manifest.state_schema?.fields;
	if (!fields || typeof fields !== "object")
		failures.push(`${manifestPath}: state_schema.fields is required`);
	for (const [path, field] of Object.entries(fields ?? {})) {
		if (field.model_writable && !Array.isArray(field.operations))
			failures.push(`${manifestPath}: writable state ${path} needs an operation allowlist`);
		if (
			field.model_writable &&
			field.type === "number" &&
			field.operations?.some(
				(operation) => operation === "increment" || operation === "decrement",
			) &&
			field.max_change_per_turn === undefined
		)
			failures.push(`${manifestPath}: writable numeric state ${path} needs max_change_per_turn`);
	}
	const plugins = resolve(packageRoot, "plugins");
	if (entry.name === "jizhou" && existsSync(plugins) && sourceFiles(plugins).length > 0)
		failures.push(`${plugins}: benchmark character must not depend on executable plugins`);
	const skills = resolve(packageRoot, "skills");
	if (!existsSync(skills)) continue;
	for (const file of sourceFiles(skills).filter((path) => path.endsWith("SKILL.md"))) {
		const source = readFileSync(file, "utf8");
		const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
		const metadata = frontmatter ? parse(frontmatter) : {};
		const declaredTools = Array.isArray(metadata["allowed-tools"])
			? metadata["allowed-tools"]
			: String(metadata["allowed-tools"] ?? "")
					.split(/\s+/)
					.filter(Boolean);
		for (const tool of declaredTools)
			if (!allowedHostTools.has(tool)) failures.push(`${file}: undeclared Host tool ${tool}`);
	}
}

if (allowedHostTools.size + 1 > 9)
	failures.push("model tool surface exceeds 9 tools including role_skill");
if (failures.length) {
	console.error(`Role tool-surface violations:\n${failures.join("\n")}`);
	process.exit(1);
}
console.log("Role tool surface valid: role_skill plus 8 conditional Host domain tools");
