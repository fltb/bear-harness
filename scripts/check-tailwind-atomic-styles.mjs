import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const targets = [
	resolve("packages/companion-ui/src/styles.css"),
	...readdirSync(resolve("packages/companion-ui/src/styles"))
		.filter((name) => name.endsWith(".css"))
		.map((name) => resolve("packages/companion-ui/src/styles", name)),
];
const forbiddenProperties = new Set([
	"align-items",
	"border-radius",
	"cursor",
	"display",
	"flex-wrap",
	"font-size",
	"font-weight",
	"gap",
	"grid-template-columns",
	"height",
	"justify-content",
	"line-height",
	"margin",
	"max-height",
	"max-width",
	"min-height",
	"min-width",
	"opacity",
	"overflow",
	"overflow-x",
	"overflow-y",
	"padding",
	"position",
	"width",
]);

const violations = targets.flatMap((target) =>
	(() => {
		let keyframeDepth = 0;
		return readFileSync(target, "utf8")
			.split("\n")
			.flatMap((line, index) => {
				if (/^\s*@keyframes\b/.test(line)) keyframeDepth = 1;
				else if (keyframeDepth > 0) {
					keyframeDepth += (line.match(/{/g) ?? []).length;
					keyframeDepth -= (line.match(/}/g) ?? []).length;
				}
				if (keyframeDepth > 0) return [];
				const match = line.match(/^\s*([a-z-]+):/);
				const linePrefix = `${target}:${index + 1}:`;
				const violations = [];
				if (match && forbiddenProperties.has(match[1])) {
					violations.push(`${linePrefix} use Tailwind @apply instead of '${match[1]}'`);
				}
				if (/\b[a-z-]+-?\[[^\]]*\d+(?:\.\d+)?px[^\]]*\]/.test(line)) {
					violations.push(`${linePrefix} Tailwind arbitrary pixel values are forbidden`);
				}
				return violations;
			});
	})(),
);

if (violations.length > 0) {
	console.error("Bare layout CSS is forbidden. Use standard Tailwind utilities through @apply.");
	for (const violation of violations) console.error(violation);
	process.exitCode = 1;
}
