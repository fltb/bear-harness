import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { productUi } from "../packages/product-config/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [join(repoRoot, "apps"), join(repoRoot, "packages")];
const testFile = /(?:^|\/)(?:tests?|e2e)\/.*\.(?:spec|test)\.(?:ts|tsx)$/;
const forbiddenCalls = new Map([
	["waitForTimeout", "use a web-first assertion or observable state"],
	["querySelector", "query by accessible role, label or public contract"],
	["querySelectorAll", "query by accessible role, label or public contract"],
	["toHaveClass", "assert user-visible behavior, not CSS implementation"],
	["first", "identify the element by accessible name instead of position"],
	["last", "identify the element by accessible name instead of position"],
	["nth", "identify the element by accessible name instead of position"],
]);
const productCopy = new Set();
const copyContractMethods = new Set([
	"getByRole",
	"findByRole",
	"queryByRole",
	"getByText",
	"findByText",
	"queryByText",
	"getAllByText",
	"findAllByText",
	"getByLabelText",
	"findByLabelText",
	"queryByLabelText",
	"getByPlaceholderText",
	"queryByPlaceholderText",
	"toHaveTextContent",
	"toHaveAttribute",
]);
function collectProductCopy(value) {
	if (typeof value === "string") productCopy.add(value);
	else if (Array.isArray(value)) for (const item of value) collectProductCopy(item);
	else if (value && typeof value === "object")
		for (const item of Object.values(value)) collectProductCopy(item);
}
collectProductCopy(productUi);

const files = [];
function collect(directory) {
	for (const entry of readdirSync(directory)) {
		if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) collect(path);
		else if (testFile.test(path)) files.push(path);
	}
}
for (const root of roots) collect(root);

const findings = [];
function isAllowed(sourceText, node, method) {
	const line = node.loc?.start.line ?? 1;
	const previous = sourceText.split("\n")[line - 2] ?? "";
	return new RegExp(`test-quality-allow ${method}: \\S.{8,}`).test(previous);
}

function report(file, node, message) {
	findings.push(
		`${relative(repoRoot, file)}:${node.loc?.start.line ?? 1}:${node.loc?.start.column ?? 0} ${message}`,
	);
}

for (const file of files) {
	const sourceText = readFileSync(file, "utf8");
	const source = parse(sourceText, {
		sourceType: "module",
		plugins: extname(file) === ".tsx" ? ["typescript", "jsx"] : ["typescript"],
	});
	const visit = (node, ancestors = []) => {
		const isUiTest = file.includes("packages/companion-ui/") || file.includes("/e2e/");
		const copyContract = ancestors.some(
			(ancestor) =>
				ancestor?.type === "CallExpression" &&
				ancestor.callee?.type === "MemberExpression" &&
				ancestor.callee.property?.type === "Identifier" &&
				copyContractMethods.has(ancestor.callee.property.name),
		);
		if (
			isUiTest &&
			copyContract &&
			node?.type === "StringLiteral" &&
			node.value.length > 1 &&
			productCopy.has(node.value) &&
			!isAllowed(sourceText, node, "product-copy")
		) {
			report(
				file,
				node,
				`product-owned copy ${JSON.stringify(node.value)} is forbidden: reference productUi`,
			);
		}
		if (node?.type === "CallExpression" && node.callee?.type === "MemberExpression") {
			const method =
				node.callee.property?.type === "Identifier" ? node.callee.property.name : undefined;
			const reason = forbiddenCalls.get(method);
			if (reason && !isAllowed(sourceText, node, method))
				report(file, node.callee.property, `${method} is forbidden: ${reason}`);

			if (method === "locator") {
				const selector = node.arguments[0];
				if (selector?.type === "StringLiteral" && !isAllowed(sourceText, node, "locator")) {
					report(
						file,
						selector,
						`locator(${JSON.stringify(selector.value)}) is forbidden: use role, label, text or an explicit test contract`,
					);
				}
			}

			if (
				(method === "skip" || method === "only" || method === "fixme") &&
				!file.endsWith("live-model.spec.ts")
			) {
				report(file, node.callee.property, `${method} is forbidden in required tests`);
			}
		}
		for (const value of Object.values(node ?? {})) {
			if (Array.isArray(value)) {
				for (const child of value)
					if (child && typeof child.type === "string") visit(child, [...ancestors, node]);
			} else if (value && typeof value === "object" && typeof value.type === "string")
				visit(value, [...ancestors, node]);
		}
	};
	visit(source.program);
}

if (findings.length > 0) {
	process.stderr.write(`Test quality violations:\n${findings.join("\n")}\n`);
	process.exit(1);
}

process.stdout.write(`Test quality valid: ${files.length} files checked\n`);
