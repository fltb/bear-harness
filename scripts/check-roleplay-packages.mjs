import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { imageDimensionsFromData } from "image-dimensions";
import { parse } from "yaml";

function schemaHasPointer(schema, pointer) {
	let node = schema;
	for (const escaped of pointer.slice(1).split("/")) {
		const name = escaped.replaceAll("~1", "/").replaceAll("~0", "~");
		node = node?.properties?.[name];
		if (!node) return false;
	}
	return true;
}

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

		const requiredStoryScenes = [
			"study",
			"quiet_terminal",
			"archive_gallery",
			"relay_room",
			"snowfield",
			"coastal_beacon",
			"last_shift_room",
			"future_beacon",
			"study_dawn",
		];
		const sceneIds = new Set((manifest.scenes ?? []).map((scene) => scene.id));
		for (const id of requiredStoryScenes)
			if (!sceneIds.has(id)) failures.push(`${prefix}: official story requires scene ${id}`);

		const requiredStoryMedia = [
			"damaged_signal",
			"storm_relay_map",
			"snow_route",
			"two_handoffs",
			"last_shift_desk",
			"future_beacon_cg",
			"returned_lamp",
		];
		const mediaById = new Map(roleplay.media.map((media) => [media.id, media]));
		for (const id of requiredStoryMedia) {
			const media = mediaById.get(id);
			if (!media) {
				failures.push(`${prefix}: official story requires media ${id}`);
				continue;
			}
			const visualAsset = media.poster ?? media.asset;
			const info = imageDimensionsFromData(readFileSync(new URL(visualAsset, packageRoot)));
			if (!info || info.width < 1600 || info.height < 900)
				failures.push(`${prefix}: official story media ${id} requires a production 16:9 poster`);
		}

		const requiredStateFields = [
			"/story/undelivered_report/phase",
			"/story/undelivered_report/status",
			"/story/undelivered_report/route",
			"/story/undelivered_report/position",
			"/story/undelivered_report/resolution",
			"/story/undelivered_report/testimony_stance",
			"/story/undelivered_report/future_choice",
			"/story/undelivered_report/known_facts",
			"/story/undelivered_report/user_interpretation",
			"/narrative/frame",
			"/narrative/location",
			"/narrative/time_anchor",
			"/narrative/evidence_mode",
			"/narrative/active_story",
			"/narrative/branch",
		];
		for (const path of requiredStateFields)
			if (!schemaHasPointer(manifest.state_schema, path))
				failures.push(`${prefix}: official story requires state field ${path}`);

		const storyPath = new URL("skills/undelivered-report/resources/story.md", packageRoot);
		if (!existsSync(storyPath))
			failures.push(`${prefix}: official story Skill resource is missing`);
		else {
			const story = readFileSync(storyPath, "utf8");
			const requiredHeadings = [
				"## 序章：留言簿里的断行",
				"## 第一章：损坏的信号",
				"## 第二章 A：风暴中继",
				"## 第二章 B：雪原上的脚印",
				"## 第三章：两份不一致的交接",
				"## 第四章：最后一班",
				"## 第五章：如果以后还有一座站",
				"## 终章：把回报放在哪里",
				"## 中断与恢复",
				"## 人物与指代约束",
				"## 长程稳定规则",
			];
			if (story.length < 6_000)
				failures.push(
					`${prefix}: official story Skill resource is an outline, not complete content`,
				);
			for (const heading of requiredHeadings)
				if (!story.includes(heading))
					failures.push(`${prefix}: official story canon requires ${heading}`);
		}
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
			void metadata;
		}
}

if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Roleplay package gate passed.");
}
