import { glob, readFile } from "node:fs/promises";
import { parse } from "@babel/parser";

// Only the transport recovery helper may schedule a connection retry. UI state
// must arrive via RPC mutation results or Host events, never a periodic query.
const failures = [];
for (const pattern of [
	"packages/companion-ui/src/**/*.{ts,tsx}",
	"apps/web-dev/src/**/*.{ts,tsx}",
	"apps/desktop/src/renderer/**/*.{ts,tsx}",
]) {
	for await (const file of glob(pattern)) {
		if (file === "packages/companion-ui/src/lib/host-event-reconnect.ts") continue;
		const ast = parse(await readFile(file, "utf8"), {
			sourceType: "module",
			plugins: ["typescript", "jsx"],
		});
		const visit = (node) => {
			if (!node || typeof node !== "object") return;
			if (
				node.type === "ImportDeclaration" &&
				/^(?:@earendil-works\/pi-|@bear-harness\/(?:host-runtime|tdai-core)|node:)/.test(
					node.source.value,
				)
			) {
				failures.push(
					`${file}:${node.loc.start.line} renderer must consume Host RPC, not external/runtime SDKs`,
				);
			}
			if (
				node.type === "Identifier" &&
				["fetch", "WebSocket", "EventSource", "XMLHttpRequest"].includes(node.name) &&
				file !== "apps/web-dev/src/http-client.ts" &&
				!(file === "apps/web-dev/src/index.tsx" && node.name === "fetch")
			) {
				failures.push(
					`${file}:${node.loc.start.line} network access belongs to the Host transport adapter`,
				);
			}
			if (
				node.type === "Identifier" &&
				node.name === "setQueryData" &&
				file !== "packages/companion-ui/src/stores/query-sync.ts"
			) {
				failures.push(
					`${file}:${node.loc.start.line} cache writes must cross the committed revision gate`,
				);
			}
			if (
				node.type === "Identifier" &&
				["setInterval", "setTimeout", "refetchInterval"].includes(node.name)
			) {
				failures.push(
					`${file}:${node.loc.start.line} ${node.name}: use Host push for state updates`,
				);
			}
			if (
				file.startsWith("packages/companion-ui/") &&
				node.type === "MemberExpression" &&
				node.property?.name === "subscribe" &&
				node.object?.property?.name === "events"
			) {
				failures.push(`${file}:${node.loc.start.line} use events.stream, not replay RPC`);
			}
			for (const child of Object.values(node)) {
				if (Array.isArray(child)) child.forEach(visit);
				else if (child && typeof child === "object") visit(child);
			}
		};
		visit(ast);
	}
}
if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else console.log("Renderer push-only state check passed");
