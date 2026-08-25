import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { CredentialVault } from "../providers/credential-store.js";
import type { AppDatabase } from "../storage/database.js";
import { conversationResourceRefs, resourceRefs, resourceRevisions } from "../storage/schema.js";
import type {
	FileIdentity,
	ResourceAccess,
	ResourcePersistence,
	ResourceRef,
	ResourceRefView,
	ResourceState,
} from "./types.js";

const IMMEDIATE_HASH_LIMIT = 16 * 1024 * 1024;

type ResourceRow = typeof resourceRefs.$inferSelect;

function hashFile(path: string): string {
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let bytes = 0;
		do {
			bytes = readSync(fd, buffer, 0, buffer.length, null);
			if (bytes) hash.update(buffer.subarray(0, bytes));
		} while (bytes);
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}

function identity(path: string): FileIdentity {
	const stat = lstatSync(path, { bigint: true });
	if (process.platform === "win32")
		return { realpathAtGrant: path, volumeId: String(stat.dev), fileId: String(stat.ino) };
	return { realpathAtGrant: path, deviceId: String(stat.dev), inode: String(stat.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	if (left.fileId || right.fileId)
		return left.fileId === right.fileId && left.volumeId === right.volumeId;
	return left.deviceId === right.deviceId && left.inode === right.inode;
}

export class ResourceReferenceService {
	constructor(
		private readonly db: AppDatabase,
		private readonly vault: CredentialVault,
	) {}

	grantPaths(
		paths: readonly string[],
		options: { access?: ResourceAccess; persistence?: ResourcePersistence } = {},
	): ResourceRefView[] {
		return paths.map((path) => this.grant(path, options));
	}

	grant(
		path: string,
		options: {
			access?: ResourceAccess;
			persistence?: ResourcePersistence;
			securityBookmark?: string;
		} = {},
	): ResourceRefView {
		if (!isAbsolute(path))
			throw Object.assign(new Error("resource_path_must_be_absolute"), { kind: "invalid_request" });
		if (!this.vault.isEncryptionAvailable() || this.vault.securityLevel === "session")
			throw Object.assign(new Error("secure_resource_storage_unavailable"), {
				kind: "unavailable",
			});
		const canonicalPath = realpathSync(path);
		const stat = lstatSync(canonicalPath);
		if (!stat.isFile() && !stat.isDirectory())
			throw Object.assign(new Error("unsupported_resource_kind"), { kind: "invalid_request" });
		const kind = stat.isDirectory() ? "directory" : "file";
		const now = new Date().toISOString();
		const id = `res_${randomUUID()}`;
		const baseline = {
			exists: true,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			...(kind === "file" && stat.size <= IMMEDIATE_HASH_LIMIT
				? { sha256: hashFile(canonicalPath) }
				: {}),
		};
		const locator = this.vault.encryptString(
			JSON.stringify({
				platform: process.platform,
				canonicalPath,
				securityBookmark: options.securityBookmark,
			}),
		);
		this.db
			.insert(resourceRefs)
			.values({
				id,
				kind,
				displayName: basename(canonicalPath),
				access: options.access ?? "read",
				persistence: options.persistence ?? "conversation",
				encryptedLocatorJson: locator,
				identityJson: JSON.stringify(identity(canonicalPath)),
				baselineJson: JSON.stringify(baseline),
				state: "available",
				grantedAt: now,
				lastResolvedAt: now,
			})
			.run();
		return {
			id,
			kind,
			displayName: basename(canonicalPath),
			access: options.access ?? "read",
			persistence: options.persistence ?? "conversation",
			state: "available",
			summary: kind === "file" ? { bytes: stat.size } : undefined,
		};
	}

	attachToConversation(resourceId: string, conversationId: string): void {
		this.requireRow(resourceId);
		this.db
			.insert(conversationResourceRefs)
			.values({ conversationId, resourceId })
			.onConflictDoNothing()
			.run();
	}

	detachFromConversation(resourceId: string, conversationId: string): void {
		this.db
			.delete(conversationResourceRefs)
			.where(
				and(
					eq(conversationResourceRefs.conversationId, conversationId),
					eq(conversationResourceRefs.resourceId, resourceId),
				),
			)
			.run();
	}

	listForConversation(conversationId: string): ResourceRefView[] {
		const rows = this.db
			.select({ resource: resourceRefs })
			.from(resourceRefs)
			.innerJoin(conversationResourceRefs, eq(conversationResourceRefs.resourceId, resourceRefs.id))
			.where(
				and(
					eq(conversationResourceRefs.conversationId, conversationId),
					isNull(resourceRefs.revokedAt),
				),
			)
			.orderBy(conversationResourceRefs.attachedAt)
			.all()
			.map((row) => row.resource);
		return rows.map((row) => this.view(row));
	}

	makePersistent(resourceId: string): ResourceRefView {
		this.db
			.update(resourceRefs)
			.set({ persistence: "persistent" })
			.where(and(eq(resourceRefs.id, resourceId), isNull(resourceRefs.revokedAt)))
			.run();
		return this.view(this.requireRow(resourceId));
	}

	revoke(resourceId: string): void {
		const existing = this.requireRow(resourceId);
		this.db
			.update(resourceRefs)
			.set({ revokedAt: new Date().toISOString(), encryptedLocatorJson: Buffer.alloc(0) })
			.where(eq(resourceRefs.id, existing.id))
			.run();
	}

	resolve(resourceId: string): ResourceRef {
		const row = this.requireRow(resourceId);
		let locator: ResourceRef["locator"];
		try {
			locator = JSON.parse(
				this.vault.decryptString(row.encryptedLocatorJson),
			) as ResourceRef["locator"];
		} catch {
			throw Object.assign(new Error("resource_permission_lost"), { kind: "unavailable" });
		}
		const oldIdentity = JSON.parse(row.identityJson) as FileIdentity;
		const baseline = JSON.parse(row.baselineJson) as ResourceRef["baseline"];
		let state: ResourceState = "available";
		let stat: ReturnType<typeof lstatSync>;
		let canonicalPath: string;
		try {
			canonicalPath = realpathSync(locator.canonicalPath);
			stat = lstatSync(canonicalPath);
		} catch (error) {
			state = (error as NodeJS.ErrnoException).code === "EACCES" ? "permission_lost" : "missing";
			this.updateState(resourceId, state);
			return {
				id: row.id,
				kind: row.kind,
				displayName: row.displayName,
				access: row.access,
				persistence: row.persistence,
				locator,
				identity: oldIdentity,
				baseline,
				state,
				grantedAt: row.grantedAt,
				lastResolvedAt: new Date().toISOString(),
			};
		}
		const currentIdentity = identity(canonicalPath);
		if (!sameIdentity(currentIdentity, oldIdentity)) state = "replaced";
		else if (canonicalPath !== oldIdentity.realpathAtGrant) state = "moved";
		else if (stat.size !== baseline.size || stat.mtimeMs !== baseline.mtimeMs) state = "changed";
		if (
			state === "changed" &&
			row.kind === "file" &&
			baseline.sha256 &&
			stat.size <= IMMEDIATE_HASH_LIMIT &&
			hashFile(canonicalPath) === baseline.sha256
		)
			state = "available";
		this.updateState(resourceId, state);
		return {
			id: row.id,
			kind: row.kind,
			displayName: row.displayName,
			access: row.access,
			persistence: row.persistence,
			locator: { ...locator, canonicalPath },
			identity: oldIdentity,
			baseline,
			state,
			grantedAt: row.grantedAt,
			lastResolvedAt: new Date().toISOString(),
		};
	}

	resolveView(resourceId: string): ResourceRefView {
		this.resolve(resourceId);
		return this.view(this.requireRow(resourceId));
	}

	relocate(resourceId: string, path: string, securityBookmark?: string): ResourceRefView {
		if (!isAbsolute(path))
			throw Object.assign(new Error("resource_path_must_be_absolute"), { kind: "invalid_request" });
		const row = this.requireRow(resourceId);
		const canonicalPath = realpathSync(path);
		const stat = lstatSync(canonicalPath);
		if (
			(row.kind === "file") !== stat.isFile() ||
			(row.kind === "directory") !== stat.isDirectory()
		)
			throw Object.assign(new Error("resource_kind_mismatch"), { kind: "conflict" });
		const oldIdentity = JSON.parse(row.identityJson) as FileIdentity;
		const oldBaseline = JSON.parse(row.baselineJson) as ResourceRef["baseline"];
		const nextIdentity = identity(canonicalPath);
		const nextHash =
			row.kind === "file" && stat.size <= IMMEDIATE_HASH_LIMIT
				? hashFile(canonicalPath)
				: undefined;
		const matches =
			sameIdentity(oldIdentity, nextIdentity) ||
			Boolean(oldBaseline.sha256 && nextHash === oldBaseline.sha256);
		if (!matches)
			throw Object.assign(new Error("resource_relocation_mismatch"), { kind: "conflict" });
		const nextBaseline = {
			exists: true,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			...(nextHash ? { sha256: nextHash } : {}),
		};
		this.db.transaction((transaction) => {
			transaction
				.insert(resourceRevisions)
				.values({
					id: randomUUID(),
					resourceId,
					identityJson: row.identityJson,
					baselineJson: row.baselineJson,
				})
				.run();
			transaction
				.update(resourceRefs)
				.set({
					encryptedLocatorJson: this.vault.encryptString(
						JSON.stringify({ platform: process.platform, canonicalPath, securityBookmark }),
					),
					identityJson: JSON.stringify(nextIdentity),
					baselineJson: JSON.stringify(nextBaseline),
					state: "available",
					lastResolvedAt: new Date().toISOString(),
				})
				.where(eq(resourceRefs.id, resourceId))
				.run();
		});
		return this.view(this.requireRow(resourceId));
	}

	private updateState(id: string, state: ResourceState): void {
		this.db
			.update(resourceRefs)
			.set({ state, lastResolvedAt: new Date().toISOString() })
			.where(eq(resourceRefs.id, id))
			.run();
	}
	private requireRow(id: string): ResourceRow {
		const row = this.db
			.select()
			.from(resourceRefs)
			.where(and(eq(resourceRefs.id, id), isNull(resourceRefs.revokedAt)))
			.get();
		if (!row) throw Object.assign(new Error("resource_not_found"), { kind: "not_found" });
		return row;
	}
	private view(row: ResourceRow): ResourceRefView {
		const baseline = JSON.parse(row.baselineJson) as { size?: number };
		return {
			id: row.id,
			kind: row.kind,
			displayName: row.displayName,
			access: row.access,
			persistence: row.persistence,
			state: row.state,
			summary: row.kind === "file" ? { bytes: baseline.size } : undefined,
		};
	}
}
