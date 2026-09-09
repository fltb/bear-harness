import { join } from "node:path";

export function normalizeArchivePath(value) {
	const normalized = value.split("\\").join("/");
	return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function resolveMacOutputDirectory(releaseRoot, arch, pathExists) {
	for (const directory of [`mac-${arch}`, "mac"]) {
		const candidate = join(releaseRoot, directory);
		if (pathExists(candidate)) return candidate;
	}
	throw new Error(`Packaged macOS directory is missing below ${releaseRoot}`);
}
