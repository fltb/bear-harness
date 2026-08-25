import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { codecRegistry } from "../materials/codec.js";
import { sniffKind } from "../materials/ingest.js";
import type { AppDatabase } from "../storage/database.js";
import { resourceReads } from "../storage/schema.js";
import type { ResourceReferenceService } from "./reference-service.js";

const MAX_READ_BYTES = 10 * 1024 * 1024;
const IGNORED = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"target",
	".next",
	".cache",
	"coverage",
]);

export interface ResourceReadContext {
	conversationId?: string;
	runId?: string;
	reader: string;
}
export interface DirectoryEntry {
	relativePath: string;
	name: string;
	kind: "file" | "directory";
	bytes?: number;
	mtimeMs: number;
}
export interface DirectoryIndexRevision {
	resourceId: string;
	generatedAt: string;
	rootRevision: string;
	entryCount: number;
	truncated: boolean;
}
type IndexedEntry = DirectoryEntry & { searchableText: string };

export class ResourceContentService {
	private readonly directoryIndexes = new Map<
		string,
		{ revision: DirectoryIndexRevision; entries: IndexedEntry[] }
	>();
	constructor(
		private readonly db: AppDatabase,
		private readonly references: ResourceReferenceService,
	) {}

	stat(resourceId: string) {
		const resource = this.references.resolve(resourceId);
		const stat = statSync(resource.locator.canonicalPath);
		return {
			resource: this.references.resolveView(resourceId),
			bytes: stat.size,
			mtimeMs: stat.mtimeMs,
		};
	}

	readText(resourceId: string, context: ResourceReadContext, maxBytes = MAX_READ_BYTES) {
		const resource = this.references.resolve(resourceId);
		if (resource.kind !== "file")
			throw Object.assign(new Error("resource_is_not_file"), { kind: "invalid_request" });
		const stat = statSync(resource.locator.canonicalPath);
		if (stat.size > Math.min(maxBytes, MAX_READ_BYTES))
			throw Object.assign(new Error("resource_read_too_large"), { kind: "invalid_request" });
		const buffer = readFileSync(resource.locator.canonicalPath);
		const text = buffer.toString("utf8");
		this.record(resourceId, buffer, stat, context);
		return {
			text,
			bytes: buffer.length,
			sha256: createHash("sha256").update(buffer).digest("hex"),
			truncated: false,
		};
	}

	async extractDocument(resourceId: string, context: ResourceReadContext) {
		const resource = this.references.resolve(resourceId);
		if (resource.kind !== "file")
			throw Object.assign(new Error("resource_is_not_file"), { kind: "invalid_request" });
		const stat = statSync(resource.locator.canonicalPath);
		if (stat.size > MAX_READ_BYTES)
			throw Object.assign(new Error("resource_read_too_large"), { kind: "invalid_request" });
		const buffer = readFileSync(resource.locator.canonicalPath);
		const extension = extname(resource.displayName).slice(1);
		const mime = mimeForExtension(extension);
		const kind = sniffKind(mime, extension);
		const parser = codecRegistry.getParser(kind);
		if (!parser)
			throw Object.assign(new Error("resource_format_unsupported"), { kind: "invalid_request" });
		const extracted = await parser(buffer);
		if (extracted.error)
			throw Object.assign(new Error("resource_extract_failed"), { kind: "internal" });
		this.record(resourceId, buffer, stat, context);
		return {
			text: extracted.text.slice(0, 200_000),
			metadata: scalarMetadata(extracted.metadata),
			truncated: extracted.text.length > 200_000,
			mime,
		};
	}

	listDirectory(
		resourceId: string,
		relativePath = ".",
		depth = 1,
		limit = 200,
		showIgnored = false,
	): { entries: DirectoryEntry[]; truncated: boolean } {
		const resource = this.references.resolve(resourceId);
		if (resource.kind !== "directory")
			throw Object.assign(new Error("resource_is_not_directory"), { kind: "invalid_request" });
		if (relativePath.split(/[\\/]+/).includes(".."))
			throw Object.assign(new Error("resource_path_escape"), { kind: "invalid_request" });
		const root = resource.locator.canonicalPath;
		const start = resolve(root, relativePath);
		if (start !== root && !start.startsWith(`${root}${sep}`))
			throw Object.assign(new Error("resource_path_escape"), { kind: "invalid_request" });
		const entries: DirectoryEntry[] = [];
		const walk = (directory: string, level: number) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (entries.length >= limit) return;
				if (!showIgnored && IGNORED.has(entry.name)) continue;
				if (entry.isSymbolicLink()) continue;
				const path = resolve(directory, entry.name);
				const stat = statSync(path);
				entries.push({
					relativePath: relative(root, path),
					name: entry.name,
					kind: entry.isDirectory() ? "directory" : "file",
					...(entry.isFile() ? { bytes: stat.size } : {}),
					mtimeMs: stat.mtimeMs,
				});
				if (entry.isDirectory() && level < Math.min(depth, 5)) walk(path, level + 1);
			}
		};
		walk(start, 1);
		return { entries, truncated: entries.length >= limit };
	}

	search(resourceId: string, query: string, limit = 20) {
		// Refresh before every use so a cached index can never override current
		// filesystem identity and metadata checks.
		const indexed = this.buildDirectoryIndex(resourceId);
		const needle = query.toLocaleLowerCase();
		return {
			hits: indexed.entries
				.filter((entry) => entry.searchableText.includes(needle))
				.slice(0, limit)
				.map(({ searchableText: _, ...entry }) => entry),
			truncated: indexed.revision.truncated,
			revision: indexed.revision,
		};
	}

	buildDirectoryIndex(resourceId: string): {
		revision: DirectoryIndexRevision;
		entries: IndexedEntry[];
	} {
		const resource = this.references.resolve(resourceId);
		if (resource.kind !== "directory")
			throw Object.assign(new Error("resource_is_not_directory"), { kind: "invalid_request" });
		const listing = this.listDirectory(resourceId, ".", 5, 5000);
		const entries = listing.entries.map((entry) => {
			let content = "";
			if (
				entry.kind === "file" &&
				(entry.bytes ?? 0) <= 256 * 1024 &&
				/\.(?:txt|md|json|csv|ts|tsx|js|jsx|css|html|ya?ml)$/i.test(entry.name)
			) {
				const path = resolve(resource.locator.canonicalPath, entry.relativePath);
				try {
					content = readFileSync(path, "utf8").slice(0, 100_000);
				} catch {
					content = "";
				}
			}
			return { ...entry, searchableText: `${entry.relativePath}\n${content}`.toLocaleLowerCase() };
		});
		const rootRevision = createHash("sha256")
			.update(
				entries
					.map((entry) => `${entry.relativePath}:${entry.mtimeMs}:${entry.bytes ?? 0}`)
					.join("\n"),
			)
			.digest("hex");
		const revision: DirectoryIndexRevision = {
			resourceId,
			generatedAt: new Date().toISOString(),
			rootRevision,
			entryCount: entries.length,
			truncated: listing.truncated,
		};
		const index = { revision, entries };
		this.directoryIndexes.set(resourceId, index);
		return index;
	}

	private record(
		resourceId: string,
		buffer: Buffer,
		stat: Stats,
		context: ResourceReadContext,
	): void {
		this.db
			.insert(resourceReads)
			.values({
				id: `read_${randomUUID()}`,
				resourceId,
				conversationId: context.conversationId,
				runId: context.runId,
				reader: context.reader,
				contentSha256: createHash("sha256").update(buffer).digest("hex"),
				size: buffer.length,
				mtimeMs: Math.trunc(stat.mtimeMs),
				readAt: new Date().toISOString(),
			})
			.run();
	}
}

function mimeForExtension(extension: string): string {
	return (
		(
			{
				pdf: "application/pdf",
				docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
				csv: "text/csv",
				md: "text/markdown",
				txt: "text/plain",
			} as Record<string, string>
		)[extension.toLowerCase()] ?? "text/plain"
	);
}

function scalarMetadata(
	metadata: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
	return Object.fromEntries(
		Object.entries(metadata ?? {}).filter(
			(entry): entry is [string, string | number | boolean | null] =>
				entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1]),
		),
	);
}
