import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const PACKAGE_MAX_BYTES = 256 * 1024 * 1024;
export const DRAFT_WRITE_MAX_BYTES = 8 * 1024 * 1024;
export const DRAFT_READ_CHUNK_BYTES = 256 * 1024;
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function packageFilePath(path: string): string {
	if (
		path.length > 512 ||
		path.includes("\\") ||
		path
			.split("/")
			.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					[...part].some((char) => char.charCodeAt(0) < 32) ||
					/[<>:"|?*]/.test(part) ||
					/[. ]$/.test(part) ||
					/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
			)
	)
		throw { kind: "invalid_request", reason: "character_package_path_invalid" };
	return path;
}

export function packageFiles(root: string): Record<string, Buffer> {
	const files: Record<string, Buffer> = Object.create(null);
	let bytes = 0;
	const visit = (dir: string) => {
		const stat = lstatSync(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("Package directory must not be a symlink");
		for (const item of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, item.name);
			const local = packageFilePath(relative(root, path).split("\\").join("/"));
			if (item.isSymbolicLink()) throw new Error(`Package symlink: ${local}`);
			if (item.isDirectory()) visit(path);
			else {
				if (!item.isFile()) throw new Error(`Unsupported package file: ${local}`);
				bytes += lstatSync(path).size;
				if (bytes > PACKAGE_MAX_BYTES || Object.keys(files).length >= 2048)
					throw { kind: "invalid_request", reason: "character_package_size_limit" };
				files[local] = readFileSync(path);
			}
		}
	};
	visit(root);
	return files;
}
export const packageDigest = (files: Record<string, Buffer>) =>
	digest(
		JSON.stringify(
			Object.keys(files)
				.sort()
				.map((path) => [path, digest(files[path] as Buffer)]),
		),
	);
export const textFile = (path: string, bytes: Buffer) =>
	/\.(ya?ml|md|txt|json|[cm]?[jt]sx?|css|html|svg|vtt|toml|ini)$/i.test(path) &&
	!bytes.includes(0) &&
	Buffer.from(bytes.toString("utf8")).equals(bytes);
