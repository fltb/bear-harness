import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(repoRoot, "packages/host-runtime/src");
const allowedRawDatabaseModule = resolve(sourceRoot, "storage/database.ts");
const forbidden = [
	/import\s+(?:type\s+)?[^;]*from\s+["']node:sqlite["']/,
	/\.prepare\s*\(/,
	/(?:\bdb|this\.db|\bconnection|this\.connection)\.exec\s*\(/,
];
const findings = [];

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return extname(entry.name) === ".ts" ? [path] : [];
	});
}

for (const absolutePath of sourceFiles(sourceRoot)) {
	const source = readFileSync(absolutePath, "utf8");
	const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
	const visit = (node, transaction = false) => {
		if (!node || typeof node !== "object") return;
		if (
			node.type === "CallExpression" &&
			node.callee.type === "MemberExpression" &&
			node.callee.property.name === "transaction"
		) {
			const callback = node.arguments[0];
			if (
				!callback ||
				!["ArrowFunctionExpression", "FunctionExpression"].includes(callback.type) ||
				callback.async
			) {
				findings.push(
					`${relative(repoRoot, absolutePath)}:${node.loc.start.line} SQLite transaction requires an inline synchronous callback`,
				);
			}
			if (callback) visit(callback, true);
			return;
		}
		if (
			transaction &&
			(node.type === "AwaitExpression" || (node.type === "Identifier" && node.name === "Promise"))
		) {
			findings.push(
				`${relative(repoRoot, absolutePath)}:${node.loc.start.line} SQLite transaction cannot cross an async boundary`,
			);
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value))
				value.forEach((child) => {
					visit(child, transaction);
				});
			else if (value && typeof value === "object" && "type" in value) visit(value, transaction);
		}
	};
	visit(ast);
	if (absolutePath === allowedRawDatabaseModule) continue;
	for (const [index, line] of readFileSync(absolutePath, "utf8").split("\n").entries()) {
		if (forbidden.some((pattern) => pattern.test(line))) {
			findings.push(`${relative(repoRoot, absolutePath)}:${index + 1}`);
		}
	}
}

if (findings.length > 0) {
	process.stderr.write(
		`Host business modules must use Drizzle with synchronous transactions; raw SQLite is restricted to storage/database.ts:\n${findings.join("\n")}\n`,
	);
	process.exit(1);
}
