#!/usr/bin/env node
/**
 * Verifies that a packaged app contains the runtime product rather than
 * disabled integrations, build metadata, or a second staged dependency tree.
 *
 * Usage: node scripts/verify-package-boundary.mjs <mac|win|linux> <arm64|x64>
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { normalizeArchivePath, resolveMacOutputDirectory } from "./archive-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const release = resolve(here, "..", "release");
const [target, arch] = process.argv.slice(2);

function macBundleRoot() {
	const output = resolveMacOutputDirectory(release, arch, existsSync);
	const app = readdirSync(output).find((entry) => entry.endsWith(".app"));
	if (!app) throw new Error(`Application bundle is missing: ${output}`);
	return join(output, app);
}

function resourcesRoot() {
	if (target === "mac") return join(macBundleRoot(), "Contents/Resources");
	if (target === "win") return join(release, "win-unpacked", "resources");
	if (target === "linux") return join(release, "linux-unpacked", "resources");
	throw new Error(`Unsupported package target: ${target}/${arch}`);
}

function applicationRoot() {
	if (target === "mac") return join(macBundleRoot(), "Contents");
	if (target === "win") return join(release, "win-unpacked");
	if (target === "linux") return join(release, "linux-unpacked");
	throw new Error(`Unsupported package target: ${target}/${arch}`);
}

function hasPathSegment(path, segment) {
	return path.split("/").includes(segment);
}

const archive = join(resourcesRoot(), "app.asar");
if (!existsSync(archive)) throw new Error(`Application archive is missing: ${archive}`);

const localeRoot =
	target === "mac" ? join(applicationRoot(), "Resources") : join(applicationRoot(), "locales");
for (const locale of target === "mac"
	? ["en.lproj", "zh_CN.lproj", "zh_TW.lproj"]
	: ["en-US.pak", "zh-CN.pak", "zh-TW.pak"]) {
	if (!existsSync(join(localeRoot, locale))) {
		throw new Error(`Required Electron locale is missing: ${locale}`);
	}
}

const entries = listPackage(archive).map(normalizeArchivePath);
const forbidden = entries.filter((entry) => {
	if (entry.endsWith(".map") || entry.endsWith(".d.ts") || entry.endsWith(".tsbuildinfo")) {
		return true;
	}
	if (entry.startsWith("/dist/main/node_modules/")) return true;
	if (entry.includes("/officeparser/dist/officeparser.browser")) return true;
	if (entry === "/node_modules/node-llama-cpp/llama/gitRelease.bundle") return true;
	if (entry.startsWith("/node_modules/pdfjs-dist/build/")) return true;
	if (entry.startsWith("/node_modules/pdfjs-dist/web/")) return true;
	if (hasPathSegment(entry, "@tencentdb-agent-memory")) return true;
	if (hasPathSegment(entry, "tesseract.js") || hasPathSegment(entry, "tesseract.js-core")) {
		return true;
	}
	if (entry.startsWith("/node_modules/@agentclientprotocol/codex-acp/")) return true;
	return entry.startsWith("/node_modules/@openai/codex");
});

if (forbidden.length > 0) {
	throw new Error(`Forbidden production files:\n${forbidden.slice(0, 20).join("\n")}`);
}

for (const required of [
	"/dist/main/index.js",
	"/node_modules/node-llama-cpp/package.json",
	"/node_modules/@node-llama-cpp",
	"/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
	"/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
]) {
	if (!entries.some((entry) => entry === required || entry.startsWith(`${required}/`))) {
		throw new Error(`Required production path is missing: ${required}`);
	}
}

process.stdout.write(`package boundary verified: ${target}/${arch} (${entries.length} entries)\n`);
