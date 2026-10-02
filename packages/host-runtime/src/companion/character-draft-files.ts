import { posix } from "node:path";
import { isScalar, isSeq, parseDocument } from "yaml";
import { textFile } from "./character-package-files.js";

/** Rewrite declared asset/Skill references and Markdown links in the same revision as a move. */
export function moveDraftFiles(files: Record<string, Buffer>, from: string, to: string) {
	if (to.startsWith(`${from}/`) || from === to)
		throw { kind: "invalid_request", reason: "character_draft_move_invalid" };
	const paths = Object.keys(files).filter((path) => path === from || path.startsWith(`${from}/`));
	if (!paths.length) throw { kind: "not_found", reason: "character_draft_file_not_found" };
	if (paths.includes("character.yaml"))
		throw { kind: "invalid_request", reason: "character_manifest_move_forbidden" };
	const mapping = new Map(paths.map((path) => [path, to + path.slice(from.length)]));
	for (const next of mapping.values())
		if (files[next] && !mapping.has(next))
			throw { kind: "conflict", reason: "character_draft_file_exists" };
	const result: Record<string, Buffer> = Object.create(null);
	for (const [path, bytes] of Object.entries(files)) {
		const nextPath = mapping.get(path) ?? path;
		let source = bytes.toString("utf8");
		const relative = (value: string, root = false) => {
			if (/^(?:[a-z]+:|\/|#)/i.test(value)) return value;
			const [target, fragment] = value.split(/(?=#)/, 2);
			const resolved = root
				? (target as string)
				: posix.normalize(posix.join(posix.dirname(path), target as string));
			const moved = mapping.get(resolved) ?? resolved;
			const rewritten = root ? moved : posix.relative(posix.dirname(nextPath), moved);
			return `${rewritten}${fragment ?? ""}`;
		};
		if (textFile(path, bytes)) {
			if (path === "character.yaml") {
				const doc = parseDocument(source);
				if (doc.errors.length) throw { kind: "conflict", reason: "character_yaml_fix_before_move" };
				const rewrite = (path: Array<string | number>) => {
					const node = doc.getIn(path, true);
					if (isScalar(node) && typeof node.value === "string")
						node.value = relative(node.value, true);
				};
				rewrite(["visual", "avatar"]);
				for (const [path, fields] of [
					[["scenes"], ["background"]],
					[["visual", "expressions"], ["asset"]],
					[["media"], ["asset", "poster", "captions"]],
				] as const) {
					const items = doc.getIn(path, true);
					if (isSeq(items))
						items.items.forEach((_, index) => {
							for (const field of fields) rewrite([...path, index, field]);
						});
				}
				source = String(doc);
			} else if (path.endsWith("/SKILL.md")) {
				const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
				if (!match) throw { kind: "conflict", reason: "character_skill_frontmatter_invalid" };
				const doc = parseDocument(match[1] as string);
				if (doc.errors.length) throw { kind: "conflict", reason: "character_yaml_fix_before_move" };
				const resources = doc.get("resources", true);
				if (isSeq(resources))
					resources.items.forEach((_, index) => {
						const node = doc.getIn(["resources", index, "path"], true);
						if (isScalar(node) && typeof node.value === "string") node.value = relative(node.value);
					});
				source = `---\n${String(doc)}---\n${source.slice(match[0].length)}`;
			}
			if (/\.(md|txt)$/i.test(path))
				source = source.replace(
					/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g,
					(_match, start: string, link: string, end: string) => `${start}${relative(link)}${end}`,
				);
			result[nextPath] = Buffer.from(source);
		} else result[nextPath] = bytes;
	}
	return result;
}
