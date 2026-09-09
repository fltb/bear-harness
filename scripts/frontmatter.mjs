import { parse } from "yaml";

/** Parse a standard YAML frontmatter document with platform-independent line endings. */
export function parseYamlFrontmatter(content) {
	const lines = content.split("\r\n").join("\n").split("\r").join("\n").split("\n");
	if (lines[0]?.trim() !== "---") return undefined;
	const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (closingIndex < 0) return undefined;
	const source = lines.slice(1, closingIndex).join("\n");
	return source.length > 0 ? parse(source) : undefined;
}
