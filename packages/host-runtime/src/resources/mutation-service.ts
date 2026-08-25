import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { evidence } from "../storage/schema.js";
import type { ResourceReferenceService } from "./reference-service.js";
import type { ResourceBaseline } from "./types.js";

const MAX_UNDO_BYTES = 16 * 1024 * 1024;
type MutationKind = "create" | "modify" | "rename" | "move" | "delete";
type MutationJournal = {
	id: string;
	resourceId: string;
	kind: MutationKind;
	relativePath?: string;
	beforeBase64?: string;
	beforeSha256?: string;
	afterSha256?: string;
};

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export class ResourceMutationService {
	constructor(
		private readonly db: AppDatabase,
		private readonly resources: ResourceReferenceService,
	) {}

	plan(
		resourceId: string,
		kind: MutationKind,
		relativePath?: string,
	): { id: string; resourceId: string; kind: MutationKind; relativePath?: string } {
		this.target(resourceId, relativePath, kind === "create");
		return { id: randomUUID(), resourceId, kind, relativePath };
	}

	validateBaseline(resourceId: string, baseline: ResourceBaseline): void {
		const resource = this.resources.resolve(resourceId);
		if (
			resource.state === "missing" ||
			resource.state === "replaced" ||
			resource.state === "permission_lost"
		)
			throw { kind: "conflict", reason: `resource_${resource.state}` };
		const path = resource.locator.canonicalPath;
		const bytes = resource.kind === "file" ? readFileSync(path) : undefined;
		if (baseline.sha256 && (!bytes || sha256(bytes) !== baseline.sha256))
			throw { kind: "conflict", reason: "resource_baseline_changed" };
	}

	create(parentResourceId: string, relativePath: string, bytes: Uint8Array): string {
		const path = this.target(parentResourceId, relativePath, true);
		if (existsSync(path)) throw { kind: "conflict", reason: "resource_already_exists" };
		return this.executeAtomic(parentResourceId, "create", path, relativePath, bytes);
	}

	modify(resourceId: string, bytes: Uint8Array, baseline: ResourceBaseline): string {
		this.validateBaseline(resourceId, baseline);
		return this.executeAtomic(resourceId, "modify", this.target(resourceId), undefined, bytes);
	}

	rename(resourceId: string, newName: string): string {
		if (
			!newName ||
			newName === "." ||
			newName === ".." ||
			newName.includes("/") ||
			newName.includes("\\")
		)
			throw { kind: "validation_failed", reason: "invalid_resource_name" };
		const source = this.target(resourceId);
		return this.moveLike(resourceId, resolve(dirname(source), newName), "rename");
	}

	move(resourceId: string, parentResourceId: string, relativePath: string): string {
		return this.moveLike(resourceId, this.target(parentResourceId, relativePath, true), "move");
	}

	delete(resourceId: string, baseline: ResourceBaseline): string {
		this.validateBaseline(resourceId, baseline);
		const path = this.target(resourceId);
		const before = readFileSync(path);
		if (before.byteLength > MAX_UNDO_BYTES)
			throw { kind: "unavailable", reason: "resource_too_large_for_safe_delete" };
		const journal = this.record(resourceId, "delete", undefined, before, undefined);
		rmSync(path);
		return journal;
	}

	executeAtomic(
		resourceId: string,
		kind: "create" | "modify",
		path: string,
		relativePath: string | undefined,
		bytes: Uint8Array,
	): string {
		const before = existsSync(path) ? readFileSync(path) : undefined;
		if (before && before.byteLength > MAX_UNDO_BYTES)
			throw { kind: "unavailable", reason: "resource_too_large_for_undo" };
		const temp = resolve(dirname(path), `.${basename(path)}.bear-${randomUUID()}.tmp`);
		const backup = resolve(dirname(path), `.${basename(path)}.bear-${randomUUID()}.bak`);
		writeFileSync(temp, bytes, { flag: "wx" });
		try {
			if (before) renameSync(path, backup);
			renameSync(temp, path);
			if (before) rmSync(backup, { force: true });
		} catch (error) {
			rmSync(temp, { force: true });
			if (before && existsSync(backup) && !existsSync(path)) renameSync(backup, path);
			throw error;
		}
		return this.record(resourceId, kind, relativePath, before, bytes);
	}

	undo(journalId: string): void {
		const row = this.db
			.select({ data: evidence.data })
			.from(evidence)
			.where(eq(evidence.id, journalId))
			.get();
		const journal = row?.data as MutationJournal | undefined;
		if (!journal || journal.id !== journalId)
			throw { kind: "not_found", reason: "mutation_journal_not_found" };
		const path = this.target(journal.resourceId, journal.relativePath, journal.kind === "create");
		if (
			journal.afterSha256 &&
			existsSync(path) &&
			sha256(readFileSync(path)) !== journal.afterSha256
		)
			throw { kind: "conflict", reason: "resource_changed_since_mutation" };
		if (journal.beforeBase64)
			this.executeAtomic(
				journal.resourceId,
				"modify",
				path,
				journal.relativePath,
				Buffer.from(journal.beforeBase64, "base64"),
			);
		else rmSync(path, { force: true });
	}

	private moveLike(resourceId: string, destination: string, kind: "rename" | "move"): string {
		if (!isAbsolute(destination))
			throw { kind: "validation_failed", reason: "destination_must_be_absolute" };
		const source = this.target(resourceId);
		if (existsSync(destination)) throw { kind: "conflict", reason: "destination_exists" };
		renameSync(source, destination);
		return this.record(resourceId, kind, undefined, undefined, undefined);
	}

	private record(
		resourceId: string,
		kind: MutationKind,
		relativePath: string | undefined,
		before?: Uint8Array,
		after?: Uint8Array,
	): string {
		const id = randomUUID();
		const data: MutationJournal = {
			id,
			resourceId,
			kind,
			relativePath,
			beforeBase64: before ? Buffer.from(before).toString("base64") : undefined,
			beforeSha256: before ? sha256(before) : undefined,
			afterSha256: after ? sha256(after) : undefined,
		};
		this.db.insert(evidence).values({ id, kind: "resource_mutation", data }).run();
		return id;
	}

	private target(resourceId: string, relativePath?: string, requireDirectory = false): string {
		const resource = this.resources.resolve(resourceId);
		if (resource.access !== "read-write") throw { kind: "forbidden", reason: "resource_read_only" };
		if (!relativePath) return resource.locator.canonicalPath;
		if (requireDirectory && resource.kind !== "directory")
			throw { kind: "validation_failed", reason: "resource_not_directory" };
		if (isAbsolute(relativePath))
			throw { kind: "validation_failed", reason: "relative_path_required" };
		const root = resource.locator.canonicalPath;
		const path = resolve(root, relativePath);
		const relation = relative(root, path);
		if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
			throw { kind: "validation_failed", reason: "resource_path_escape" };
		return path;
	}
}
