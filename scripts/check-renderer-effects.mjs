import { glob, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const reactiveWriters = new Set([
	"createEffect",
	"createRenderEffect",
	"createComputed",
	"createReaction",
]);
const domAdapter = "packages/companion-ui/src/lib/dom-effects.ts";

export function checkRendererEffects(source, file) {
	const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
	const failures = [];
	const visit = (node) => {
		if (!node || typeof node !== "object") return;
		if (
			file !== domAdapter &&
			["Identifier", "StringLiteral"].includes(node.type) &&
			reactiveWriters.has(node.name ?? node.value)
		) {
			failures.push(
				`${file}:${node.loc.start.line} ${node.name}: derive values, use Query for reads and explicit events/Mutations for writes`,
			);
		}
		if (file === domAdapter) {
			// No application imports, setters, indirect helpers or mutable-state APIs may
			// hide in the narrow DOM exception. Its only callable inputs are read accessors.
			if (node.type === "ImportDeclaration" && node.source.value !== "solid-js")
				failures.push(`${file}: DOM adapters cannot import application code`);
			if (
				node.type === "CallExpression" &&
				!(
					node.callee.type === "Identifier" &&
					["createEffect", "title", "element", "entries"].includes(node.callee.name)
				)
			)
				failures.push(`${file}: unexpected call inside DOM adapter`);
			if (
				node.type === "AssignmentExpression" &&
				!(
					node.left.type === "MemberExpression" &&
					["title", "scrollTop"].includes(node.left.property.name)
				)
			)
				failures.push(`${file}: DOM adapters cannot write application state`);
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) value.forEach(visit);
			else if (value && typeof value === "object" && "type" in value) visit(value);
		}
	};
	visit(ast);
	return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const failures = [];
	for (const pattern of [
		"packages/companion-ui/src/**/*.{ts,tsx}",
		"apps/web-dev/src/**/*.{ts,tsx}",
		"apps/desktop/src/renderer/**/*.{ts,tsx}",
	]) {
		for await (const file of glob(pattern))
			failures.push(...checkRendererEffects(await readFile(file, "utf8"), file));
	}
	if (failures.length) {
		console.error(failures.join("\n"));
		process.exitCode = 1;
	} else console.log("Renderer effect boundary check passed");
}
