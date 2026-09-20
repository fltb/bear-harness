import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Resolve only outputs for the requested runner; never fall back to another architecture. */
export function resolvePackagedBinary(releaseDir, platform, arch, executableName) {
	const directories = {
		"darwin:arm64": ["mac-arm64"],
		"darwin:x64": ["mac", "mac-x64"],
		"win32:x64": ["win-unpacked"],
		"linux:x64": ["linux-unpacked"],
	}[`${platform}:${arch}`];
	if (!directories) throw new Error(`Unsupported packaged smoke target: ${platform}/${arch}`);
	const matches = directories.map((name) => join(releaseDir, name)).filter(existsSync);
	if (matches.length !== 1) {
		throw new Error(
			`Expected exactly one ${platform}/${arch} package directory; found ${matches.length} under ${releaseDir}`,
		);
	}
	const directory = matches[0];
	let binary;
	if (platform === "darwin") {
		const apps = readdirSync(directory, { withFileTypes: true }).filter(
			(entry) => entry.isDirectory() && entry.name.endsWith(".app"),
		);
		if (apps.length !== 1) throw new Error(`Expected exactly one .app bundle under ${directory}`);
		binary = join(directory, apps[0].name, "Contents", "MacOS", executableName);
	} else {
		binary = join(directory, `${executableName}${platform === "win32" ? ".exe" : ""}`);
	}
	if (!existsSync(binary)) throw new Error(`Packaged binary missing: ${binary}`);
	const stat = statSync(binary);
	if (!stat.isFile() || stat.size === 0)
		throw new Error(`Packaged binary is not a non-empty file: ${binary}`);
	return binary;
}
