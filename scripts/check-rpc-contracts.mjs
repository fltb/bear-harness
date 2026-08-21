import { readdirSync, readFileSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { parse } from "@babel/parser";

const sourceExtensions = new Set([".ts", ".tsx", ".cts"]);

function collectTypeScriptFiles(directory) {
	const files = [];
	const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	for (const entry of entries) {
		if (entry.isDirectory() && (entry.name === "dist" || entry.name === "node_modules")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectTypeScriptFiles(path));
		} else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
			files.push(path.split(sep).join("/"));
		}
	}
	return files;
}

const files = ["apps", "packages"]
	.flatMap(collectTypeScriptFiles)
	.filter((file) => !file.includes("/dist/"));
const failures = [];

const rpcChannels = new Map();
const rpcFacadeTargets = new Set();
const rpcEndpointSchemas = new Map();

function collectProtocolContract(node, file, source) {
	if (!node || typeof node !== "object") return;
	if (file === "packages/protocol/src/index.ts") {
		const facadePattern =
			/export\s+type\s+([A-Za-z0-9_]+)\s*=\s*z\.infer\s*<\s*typeof\s+schema\.([A-Za-z0-9_]+)\s*>/gs;
		for (const match of source.matchAll(facadePattern)) rpcFacadeTargets.add(match[2]);
		return;
	}
	if (
		file === "packages/protocol/src/schema.ts" &&
		node.type === "CallExpression" &&
		node.callee?.type === "Identifier" &&
		node.callee.name === "endpoint"
	) {
		const [channel, request, response] = node.arguments ?? [];
		if (
			channel?.type === "StringLiteral" &&
			request?.type === "Identifier" &&
			response?.type === "Identifier"
		) {
			const previous = rpcChannels.get(channel.value);
			if (previous)
				failures.push(
					`${file}:${channel.loc?.start.line ?? 0}: duplicate RPC channel ${JSON.stringify(channel.value)} (already declared at line ${previous})`,
				);
			else rpcChannels.set(channel.value, channel.loc?.start.line ?? 0);
			if (!/:v\d+$/.test(channel.value))
				failures.push(
					`${file}:${channel.loc?.start.line ?? 0}: RPC channel ${JSON.stringify(channel.value)} must end with :vN`,
				);
			rpcEndpointSchemas.set(channel.value, {
				request: request.name,
				response: response.name,
				line: channel.loc?.start.line ?? 0,
			});
		}
	}
	for (const value of Object.values(node)) {
		if (Array.isArray(value))
			for (const child of value) collectProtocolContract(child, file, source);
		else if (value && typeof value === "object" && "type" in value)
			collectProtocolContract(value, file, source);
	}
}

function visit(node, file) {
	if (!node || typeof node !== "object") return;
	const criticalProjection =
		file === "packages/host-runtime/src/companion/context-pack.ts" ||
		file === "packages/host-runtime/src/companion/character-behavior.ts";
	if (criticalProjection && node.type === "CatchClause") {
		failures.push(
			`${file}:${node.loc?.start.line ?? 0}: do not recover from corrupt persisted projection data; let the boundary report it`,
		);
	}
	if (
		file === "packages/companion-ui/src/stores/companion.tsx" &&
		node.type === "CallExpression" &&
		node.callee?.type === "MemberExpression" &&
		node.callee.object?.type === "Identifier" &&
		node.callee.object.name === "Promise" &&
		node.callee.property?.type === "Identifier" &&
		node.callee.property.name === "allSettled"
	) {
		failures.push(
			`${file}:${node.loc?.start.line ?? 0}: supplementary projection refresh must expose failure; do not use Promise.allSettled`,
		);
	}
	if (node.type === "CallExpression" && node.callee?.type === "MemberExpression") {
		const name =
			node.callee.property?.type === "Identifier" ? node.callee.property.name : undefined;
		const first = node.arguments?.[0];
		if (
			(name === "registerHandler" || name === "invoke") &&
			first?.type === "StringLiteral" &&
			/:v\d+$/.test(first.value)
		) {
			failures.push(
				`${file}:${first.loc?.start.line ?? 0}: use an RPC endpoint object, not ${JSON.stringify(first.value)}`,
			);
		}
	}
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) for (const child of value) visit(child, file);
		else if (value && typeof value === "object" && "type" in value) visit(value, file);
	}
}

for (const file of files) {
	const source = readFileSync(file, "utf8");
	const legacyLibraryName = ["Type", "Box"].join("");
	const legacyPackageName = ["@sinclair", "typebox"].join("/");
	const forbiddenSchemaSyntax = [
		[
			new RegExp(`${legacyPackageName}|\\b${legacyLibraryName}\\b`),
			"legacy schema dependency or API",
		],
		[
			/\bS\.(?:String|Integer|Boolean|Null|Literal|Optional|Array|Object|Union|Record|Unknown)\b/,
			"legacy schema DSL",
		],
		[/\bStatic\s*</, "legacy Static type inference"],
	];
	for (const [pattern, description] of forbiddenSchemaSyntax) {
		if (pattern.test(source))
			failures.push(`${file}: remove forbidden ${description}; use native Zod`);
	}
	const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
	if (file === "packages/protocol/src/schema.ts" || file === "packages/protocol/src/index.ts")
		collectProtocolContract(ast, file, source);
	visit(ast, file);
}

for (const [channel, endpoint] of rpcEndpointSchemas) {
	// Endpoint request/response schemas are payload types; the facade must expose
	// each underlying schema without forcing consumers to import the runtime module.
	for (const schemaName of [endpoint.request, endpoint.response]) {
		if (!rpcFacadeTargets.has(schemaName))
			failures.push(
				`packages/protocol/src/index.ts: missing inferred facade alias for ${schemaName} (${channel}, schema line ${endpoint.line})`,
			);
	}
}

if (failures.length) {
	process.stderr.write(`RPC contract gate failed:\n${failures.join("\n")}\n`);
	process.exit(1);
}
process.stdout.write("RPC contract gate: ok\n");
