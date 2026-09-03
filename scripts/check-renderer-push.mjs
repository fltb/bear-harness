import { glob, readFile } from "node:fs/promises";
import { parse } from "@babel/parser";

// UI state must arrive via RPC mutation results or Host events, never a
// periodic query. The bounded timers below do not poll state: one backs off a
// failed Pi event transport, one releases a browser download URL, and one
// clears transient copy feedback.
const allowedTimeouts = new Set([
	"packages/companion-ui/src/stores/companion.tsx:waitForPiReconnect",
	"packages/companion-ui/src/WorkPanel.tsx:downloadArtifactInBrowser",
	"packages/companion-ui/src/ConversationPanel.tsx:PiTimelineEntryView",
]);
const failures = [];
for (const pattern of [
	"packages/companion-ui/src/**/*.{ts,tsx}",
	"apps/web-dev/src/**/*.{ts,tsx}",
	"apps/desktop/src/renderer/**/*.{ts,tsx}",
]) {
	for await (const file of glob(pattern)) {
		const ast = parse(await readFile(file, "utf8"), {
			sourceType: "module",
			plugins: ["typescript", "jsx"],
		});
		const visit = (node, enclosingFunction = "") => {
			if (!node || typeof node !== "object") return;
			const functionName =
				node.type === "FunctionDeclaration" && node.id?.name ? node.id.name : enclosingFunction;
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
			if (node.type === "Identifier" && node.name === "refetchInterval") {
				failures.push(
					`${file}:${node.loc.start.line} ${node.name}: use Host push for state updates`,
				);
			}
			if (
				node.type === "CallExpression" &&
				node.callee?.type === "Identifier" &&
				["setInterval", "setTimeout"].includes(node.callee.name) &&
				!allowedTimeouts.has(`${file}:${functionName}`)
			) {
				failures.push(
					`${file}:${node.loc.start.line} ${node.callee.name}: use Host push for state updates`,
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
				if (Array.isArray(child)) {
					for (const item of child) visit(item, functionName);
				} else if (child && typeof child === "object") visit(child, functionName);
			}
		};
		visit(ast);
	}
}
if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else console.log("Renderer push-only state check passed");
