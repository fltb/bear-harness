import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const allowedHostTools = new Set([
	"host_state",
	"host_history",
	"host_canon",
	"host_memory",
	"host_delegate",
]);
const retired = [
	"host_get_state",
	"host_set_scene",
	"host_set_expression",
	"host_get_resources_state",
	"host_trigger_resources_event",
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

function schemaLeaves(schema, pointer = "", leaves = new Map()) {
	if (!schema || typeof schema !== "object") return leaves;
	if (schema.type !== "object" && !schema.properties) leaves.set(pointer, schema);
	for (const [name, child] of Object.entries(schema.properties ?? {}))
		schemaLeaves(child, `${pointer}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`, leaves);
	return leaves;
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
	const stateSchema = manifest.state_schema;
	const fields = schemaLeaves(stateSchema);
	if (stateSchema?.type !== "object" || !stateSchema.properties || fields.size === 0)
		failures.push(`${manifestPath}: state_schema must be a recursive object JSON Schema`);
	for (const [path, field] of fields) {
		if (field["x-write-authority"] === "model" && field["x-evidence-required"] !== true)
			failures.push(`${manifestPath}: model-writable state ${path} needs evidence`);
		if (
			field["x-write-authority"] === "model" &&
			field.type === "number" &&
			(typeof field.minimum !== "number" || typeof field.maximum !== "number")
		)
			failures.push(`${manifestPath}: writable numeric state ${path} needs minimum and maximum`);
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
console.log("Role tool surface valid: role_skill plus 6 conditional Host domain tools");
