import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export function nativeBindingBinaryPath(packagePath, bindingName) {
	return join(packagePath, "bins", bindingName, "llama-addon.node");
}

export function assertNonEmptyNativeBinary(path) {
	if (!existsSync(path)) throw new Error(`Packaged native binding binary is missing: ${path}`);
	const stat = statSync(path);
	if (!stat.isFile()) throw new Error(`Packaged native binding binary is not a file: ${path}`);
	if (stat.size === 0) throw new Error(`Packaged native binding binary is empty: ${path}`);
}
