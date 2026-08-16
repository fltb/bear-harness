import { glob, readFile } from "node:fs/promises";
import { parse } from "@babel/parser";

const roots = ["packages/companion-ui/src/**/*.{ts,tsx}", "apps/web-dev/src/**/*.{ts,tsx}"];
const forbiddenElements = new Set([
	"a",
	"button",
	"input",
	"label",
	"option",
	"select",
	"textarea",
]);
const forbiddenRoles = new Set([
	"button",
	"checkbox",
	"combobox",
	"dialog",
	"link",
	"listbox",
	"option",
	"radio",
	"switch",
	"tab",
	"textbox",
]);
const failures = [];

function literalAttribute(node, name) {
	const attribute = node.attributes.find(
		(candidate) =>
			candidate.type === "JSXAttribute" &&
			candidate.name.type === "JSXIdentifier" &&
			candidate.name.name === name,
	);
	return attribute?.value?.type === "StringLiteral" ? attribute.value.value : undefined;
}

for (const pattern of roots) {
	for await (const file of glob(pattern)) {
		const source = await readFile(file, "utf8");
		const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
		const visit = (node) => {
			if (!node || typeof node !== "object") return;
			if (node.type === "ImportDeclaration" && node.source.value === "@kobalte/core") {
				failures.push(`${file}:${node.loc?.start.line ?? 0} use a Kobalte component subpath`);
			}
			if (
				node.type === "JSXOpeningElement" &&
				node.name.type === "JSXIdentifier" &&
				node.name.name === node.name.name.toLowerCase()
			) {
				const element = node.name.name;
				if (forbiddenElements.has(element)) {
					failures.push(`${file}:${node.loc?.start.line ?? 0} native <${element}>`);
				}
				const role = literalAttribute(node, "role");
				if (role && forbiddenRoles.has(role)) {
					failures.push(`${file}:${node.loc?.start.line ?? 0} handwritten role=${role}`);
				}
				const attributeNames = new Set(
					node.attributes
						.filter(
							(attribute) =>
								attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier",
						)
						.map((attribute) => attribute.name.name),
				);
				if (
					attributeNames.has("onClick") ||
					(attributeNames.has("tabIndex") && attributeNames.has("onKeyDown"))
				) {
					failures.push(`${file}:${node.loc?.start.line ?? 0} interactive intrinsic <${element}>`);
				}
			}
			for (const value of Object.values(node)) {
				if (Array.isArray(value)) value.forEach(visit);
				else if (value && typeof value === "object" && "type" in value) visit(value);
			}
		};
		visit(ast);
	}
}

if (failures.length > 0) {
	console.error(
		"UI interaction primitives must come directly from Kobalte:\n" + failures.join("\n"),
	);
	process.exitCode = 1;
}
