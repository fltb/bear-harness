import { glob, readFile } from "node:fs/promises";
import { parse } from "@babel/parser";

const failures = [];
for await (const file of glob("packages/companion-ui/src/**/*.{ts,tsx}")) {
	const source = await readFile(file, "utf8");
	const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
	const visit = (node) => {
		if (!node || typeof node !== "object") return;
		if (
			node.type === "JSXOpeningElement" &&
			node.name.type === "JSXIdentifier" &&
			node.name.name === "button"
		) {
			const attributes = new Set(
				node.attributes
					.filter(
						(attribute) =>
							attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier",
					)
					.map((attribute) => attribute.name.name),
			);
			if (
				!["class", "classList", "data-variant", "data-control", "role"].some((name) =>
					attributes.has(name),
				)
			) {
				failures.push(`${file}:${node.loc?.start.line ?? 0}`);
			}
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) value.forEach(visit);
			else if (value && typeof value === "object" && "type" in value) visit(value);
		}
	};
	visit(ast);
}

if (failures.length > 0) {
	console.error("Buttons without an explicit visual-control semantic:\n" + failures.join("\n"));
	process.exitCode = 1;
}
