import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

export interface CanonDocument {
	/** Package-relative identity; no authored manifest or routing graph. */
	id: string;
	path: string;
	title: string;
	content: string;
}
export interface LoadedCanonPackage {
	sources: CanonDocument[];
}

/** Discover reference documents through the package's safe path resolver. */
export function loadCanonDocuments(
	packageDirectory: string,
	resolveContent: (path: string) => string,
): LoadedCanonPackage {
	if (!existsSync(join(packageDirectory, "canon"))) return { sources: [] };
	const pending = [{ path: "canon", depth: 0 }];
	const sources: CanonDocument[] = [];
	let bytes = 0;
	while (pending.length) {
		const current = pending.pop();
		if (!current) break;
		if (current.depth > 16) throw new Error("canon directory exceeds maximum depth");
		for (const name of readdirSync(resolveContent(current.path)).sort()) {
			const path = `${current.path}/${name}`;
			if (path === "canon/manifest.yaml")
				throw new Error("canon manifest is obsolete; convert the v1 package before loading");
			const physical = resolveContent(path);
			const stat = lstatSync(physical);
			if (stat.isDirectory()) {
				pending.push({ path, depth: current.depth + 1 });
				continue;
			}
			if (!stat.isFile() || ![".md", ".txt"].includes(extname(name).toLowerCase()))
				throw new Error(`unsupported Canon document: ${path}; import as Markdown or text`);
			bytes += stat.size;
			if (stat.size > 4 * 1024 * 1024 || bytes > 32 * 1024 * 1024 || sources.length >= 1000)
				throw new Error("canon documents exceed package limits");
			const content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(physical));
			const title =
				/^#[ \t]+(.+)$/mu.exec(content)?.[1]?.trim() ?? name.replace(/\.(md|txt)$/iu, "");
			if (!title || title.length > 255)
				throw new Error(`Canon title must be 1–255 characters: ${path}`);
			sources.push({ id: path, path, title, content });
		}
	}
	return { sources: sources.sort((a, b) => a.path.localeCompare(b.path)) };
}
