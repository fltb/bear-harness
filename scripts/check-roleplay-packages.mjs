import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse } from "yaml";

const visualOnlyTools = new Set(["host_visual", "host_present"]);

function pngInfo(path) {
	const bytes = readFileSync(path);
	if (bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
	return {
		width: bytes.readUInt32BE(16),
		height: bytes.readUInt32BE(20),
		colorType: bytes[25],
	};
}

const root = new URL("../config/characters/", import.meta.url);
const failures = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const packageRoot = new URL(`${entry.name}/`, root);
	const manifestPath = new URL("character.yaml", packageRoot);
	if (!existsSync(manifestPath)) continue;
	const manifest = parse(readFileSync(manifestPath, "utf8"));
	const prefix = `config/characters/${entry.name}`;
	const roleplay = manifest.roleplay;
	if (
		!roleplay ||
		!Array.isArray(roleplay.variables) ||
		!Array.isArray(roleplay.media) ||
		!Array.isArray(roleplay.events) ||
		!Array.isArray(roleplay.choice_sets)
	) {
		failures.push(`${prefix}: missing complete roleplay declaration`);
		continue;
	}
	for (const media of roleplay.media) {
		for (const field of ["asset", "poster", "captions"]) {
			if (media[field] && !existsSync(new URL(media[field], packageRoot)))
				failures.push(`${prefix}: missing media ${field} ${media[field]}`);
		}
		if (media.kind === "animation" && !media.poster)
			failures.push(`${prefix}: animation ${media.id} has no reduced-motion poster`);
		if (
			media.kind === "animation" &&
			![".gif", ".webp", ".apng", ".png"].includes(extname(media.asset).toLowerCase())
		)
			failures.push(`${prefix}: animation ${media.id} is not a supported animated image`);
	}
	const expressions = manifest.visual?.expressions;
	if (!Array.isArray(expressions) || expressions.length === 0)
		failures.push(`${prefix}: visual.expressions must declare at least one expression`);
	const expressionIds = new Set();
	for (const expression of expressions ?? []) {
		if (!expression?.id || !expression?.asset || !expression?.label || !expression?.use_when)
			failures.push(`${prefix}: each expression requires id, label, asset and use_when`);
		if (expressionIds.has(expression?.id))
			failures.push(`${prefix}: duplicate expression ${expression?.id}`);
		expressionIds.add(expression?.id);
		if (expression?.asset && !existsSync(new URL(expression.asset, packageRoot)))
			failures.push(`${prefix}: missing expression asset ${expression.asset}`);
	}
	if (!expressionIds.has(manifest.visual?.default_expression))
		failures.push(`${prefix}: default_expression must reference a declared expression`);
	for (const scene of manifest.scenes ?? [])
		if (!scene?.id || !scene?.label || !scene?.description || !scene?.use_when)
			failures.push(`${prefix}: each scene requires id, label, description and use_when`);
	for (const event of roleplay.events)
		for (const effect of event.effects ?? [])
			if (effect.type === "expression" && !expressionIds.has(effect.expression))
				failures.push(
					`${prefix}: event ${event.id} references missing expression ${effect.expression}`,
				);
	if (entry.name === "jizhou") {
		const expressionAssets = (expressions ?? []).map((expression) => expression.asset);
		if (expressionAssets.length < 12 || new Set(expressionAssets).size < 12)
			failures.push(`${prefix}: benchmark character requires 12 distinct expression assets`);
		if (!roleplay.media.some((media) => media.kind === "animation"))
			failures.push(`${prefix}: benchmark character requires animated media`);
		const expressionInfo = expressionAssets.map((asset) => pngInfo(new URL(asset, packageRoot)));
		if (
			expressionInfo.some(
				(info) => info?.width !== 1086 || info?.height !== 1448 || info?.colorType !== 6,
			)
		)
			failures.push(`${prefix}: benchmark expressions must all be 1086x1448 RGBA PNG files`);
	}
	const skillsRoot = new URL("skills/", packageRoot);
	if (existsSync(skillsRoot))
		for (const skill of readdirSync(skillsRoot, { withFileTypes: true })) {
			if (!skill.isDirectory()) continue;
			const skillPath = new URL(`${skill.name}/SKILL.md`, skillsRoot);
			if (!existsSync(skillPath)) continue;
			const source = readFileSync(skillPath, "utf8");
			const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
			if (!frontmatter) {
				failures.push(`${prefix}: Skill ${skill.name} requires YAML frontmatter`);
				continue;
			}
			const metadata = parse(frontmatter);
			const tools = String(metadata["allowed-tools"] ?? "")
				.split(/\s+/)
				.filter(Boolean);
			if (tools.length > 0 && tools.every((tool) => visualOnlyTools.has(tool)))
				failures.push(
					`${prefix}: Skill ${skill.name} only wraps visual Host tools; put automatic visual selection in character.yaml`,
				);
		}
}

if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Roleplay package gate passed.");
}
