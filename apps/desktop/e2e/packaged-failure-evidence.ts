import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface CommandResult {
	stdout?: unknown;
	stderr?: unknown;
}

type RunCommand = (command: string, args: string[]) => CommandResult;

const runCommand: RunCommand = (command, args) =>
	spawnSync(command, args, {
		encoding: "utf8",
		shell: false,
		timeout: 5_000,
		windowsHide: true,
	});

function filesBelow(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) break;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			if (entry.isFile()) files.push(path);
		}
	}
	return files.sort();
}

export function collectPackagedFailureEvidence(root: string, maxChars = 3_500): string {
	const parts: string[] = [];
	const diagnosticBudget = Math.max(1, Math.floor(maxChars / 2));
	const logsRoot = join(root, "logs");
	for (const file of filesBelow(logsRoot).filter((path) => path.endsWith(".jsonl"))) {
		const tail = readFileSync(file, "utf8").slice(-diagnosticBudget);
		parts.push(`[diagnostics ${relative(root, file)}]\n${tail}`);
	}

	const crashesRoot = join(root, "crashes");
	for (const file of filesBelow(crashesRoot)) {
		parts.push(`[crash ${relative(root, file)} (${statSync(file).size} bytes)]`);
	}

	if (parts.length === 0) return "no local crash evidence";
	return parts.join("\n").slice(-maxChars);
}

export function collectWindowsApplicationErrors(
	platform: NodeJS.Platform,
	run: RunCommand = runCommand,
): string {
	if (platform !== "win32") return "windows application errors unavailable";
	const result = run("wevtutil", [
		"qe",
		"Application",
		"/q:*[System[(EventID=1000)]]",
		"/c:8",
		"/rd:true",
		"/f:text",
	]);
	const output = [result.stdout, result.stderr]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join("\n")
		.trim();
	return output.length > 0 ? output.slice(-4_000) : "no Windows Application Error events";
}
