import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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

export function collectPackagedFailureEvidence(root: string, maxChars = 12_000): string {
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
