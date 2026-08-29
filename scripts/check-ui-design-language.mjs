import { glob, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import postcss from "postcss";

const repoRoot = process.env.BEAR_UI_POLICY_ROOT
	? resolve(process.env.BEAR_UI_POLICY_ROOT)
	: resolve(import.meta.dirname, "..");
const policy = JSON.parse(
	await readFile(resolve(repoRoot, "config/ui-design-system-policy.json"), "utf8"),
);
const normalize = (file) => relative(repoRoot, file).replaceAll("\\", "/");
const allowedStyles = new Set(policy.styleSheets);
const failures = [];
const definedClasses = new Set();
const usedClasses = [];
const inlineAllowlist = new Set(policy.inlineStyleAllowlist);
const headlessPrimitiveFacade = policy.headlessPrimitiveFacade;

function report(file, line, message) {
	failures.push(`${normalize(file)}:${line ?? 1} ${message}`);
}

const discoveredStyles = [];
for await (const file of glob("packages/companion-ui/src/**/*.css", { cwd: repoRoot })) {
	discoveredStyles.push(resolve(repoRoot, file));
}

for (const file of discoveredStyles) {
	const name = normalize(file);
	if (!allowedStyles.has(name)) report(file, 1, "stylesheet is not registered in the UI policy");
	const source = await readFile(file, "utf8");
	const root = postcss.parse(source, { from: file });
	root.walkRules((rule) => {
		for (const match of rule.selector.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)) {
			definedClasses.add(match[1]);
		}
		if (name !== policy.layoutStyleSheet && rule.selector.includes("[data-layout=")) {
			report(file, rule.source?.start?.line, "layout-mode selectors belong in layout.css");
		}
	});
	root.walkAtRules((rule) => {
		if (["media", "container"].includes(rule.name) && name !== policy.layoutStyleSheet) {
			report(file, rule.source?.start?.line, `@${rule.name} belongs in layout.css`);
		}
		if (rule.name === "theme" && name !== policy.tokenStyleSheet) {
			report(file, rule.source?.start?.line, "@theme belongs in base.css");
		}
		if (rule.name === "apply" && /(?:^|\s)[^\s;]*\[[^\]]+\]/.test(rule.params)) {
			report(
				file,
				rule.source?.start?.line,
				"arbitrary Tailwind values bypass the design language",
			);
		}
	});
	root.walkDecls((declaration) => {
		if (
			name !== policy.tokenStyleSheet &&
			/(?:#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\()/i.test(declaration.value)
		) {
			report(file, declaration.source?.start?.line, "palette literals belong in base.css tokens");
		}
	});
}

for (const expected of allowedStyles) {
	if (!discoveredStyles.some((file) => normalize(file) === expected)) {
		failures.push(`${expected}:1 registered stylesheet is missing`);
	}
}

function classTokens(node) {
	if (!node) return [];
	if (node.type === "StringLiteral") return node.value.split(/\s+/);
	if (node.type === "TemplateLiteral")
		return node.quasis.flatMap((part) => part.value.raw.split(/\s+/));
	return [];
}

for await (const file of glob("packages/companion-ui/src/**/*.{ts,tsx}", { cwd: repoRoot })) {
	const absolute = resolve(repoRoot, file);
	const source = await readFile(absolute, "utf8");
	const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
	const visit = (node) => {
		if (!node || typeof node !== "object") return;
		if (
			node.type === "ImportDeclaration" &&
			typeof node.source?.value === "string" &&
			node.source.value.startsWith("@kobalte/core/") &&
			file !== headlessPrimitiveFacade
		) {
			report(
				absolute,
				node.loc?.start.line,
				"headless primitives must be imported through the product UI facade",
			);
		}
		if (node.type === "JSXAttribute" && node.name?.name === "class") {
			const value =
				node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value;
			for (const token of classTokens(value)) {
				if (token && !token.includes("${"))
					usedClasses.push({ file: absolute, line: node.loc?.start.line, token });
			}
		}
		if (node.type === "JSXAttribute" && node.name?.name === "style") {
			const expression =
				node.value?.type === "JSXExpressionContainer" ? node.value.expression : undefined;
			const expressionText = expression ? source.slice(expression.start, expression.end) : "";
			const approved = [...inlineAllowlist].some((allowed) => {
				const separator = allowed.indexOf(":");
				return (
					file === allowed.slice(0, separator) &&
					expressionText.includes(allowed.slice(separator + 1))
				);
			});
			if (!approved) {
				report(absolute, node.loc?.start.line, "inline style is not approved by the UI policy");
			}
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) value.forEach(visit);
			else if (value && typeof value === "object" && "type" in value) visit(value);
		}
	};
	visit(ast.program);
}

for (const usage of usedClasses) {
	if (!definedClasses.has(usage.token)) {
		report(usage.file, usage.line, `class '${usage.token}' has no registered CSS selector`);
	}
}

if (failures.length > 0) {
	process.stderr.write(`UI design-language violations:\n${failures.join("\n")}\n`);
	process.exit(1);
}

process.stdout.write(
	`UI design language valid: ${discoveredStyles.length} registered stylesheets, ${usedClasses.length} class uses checked\n`,
);
