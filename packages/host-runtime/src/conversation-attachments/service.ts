import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { and, asc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import {
	ArtifactCorruptedError,
	type ArtifactRecord,
	type ArtifactStore,
} from "../artifacts/index.js";
import { codecRegistry } from "../materials/codec.js";
import { IngestService } from "../materials/ingest.js";
import type { AppDatabase } from "../storage/database.js";
import {
	artifacts,
	conversationAttachmentFiles,
	conversationAttachments,
} from "../storage/schema.js";

const MAX_ROOTS = 10;
const MAX_ROOT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_ENTRIES = 20_000;
const MAX_CHUNK_BYTES = 1024 * 1024;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const SEMANTIC_CONTENT_CHARS = 65_536;
const ROLE_CONTENT_CHARS = 12_000;
const MAX_SEARCH_HITS = 50;
const MAX_FOLDER_PAGE = 200;
const MAX_EXTRACTED_CHARS = 2_000_000;
export type AttachmentKind = "file" | "folder" | "generated";
export interface ConversationAttachmentSummary {
	id: string;
	name: string;
	kind: AttachmentKind;
	bytes: number;
	fileCount: number;
	originEntryId?: string;
}
export interface PreparedRunInputs {
	workspace: string;
	outputDirectory: string;
	inputs: Array<{
		attachmentId: string;
		name: string;
		path: string;
		source: "snapshot";
	}>;
}

type UploadEntry = {
	entryKind: "file" | "directory";
	relativePath: string;
	mime?: string;
	bytes?: number;
};

type UploadManifest = {
	version: 1;
	uploadId: string;
	conversationId: string;
	kind: "file" | "folder";
	name: string;
	entries: UploadEntry[];
	createdAt: number;
	expiresAt: number;
};

type StoredImportEntry =
	| { entryKind: "directory"; relativePath: string }
	| { entryKind: "symlink"; relativePath: string; linkTarget: string }
	| { entryKind: "file"; relativePath: string; sourcePath: string; mime: string };

/** Immutable, conversation-owned CAS snapshot authority. */
export class ConversationAttachmentService {
	private readonly uploads = new Map<string, UploadManifest>();
	private readonly uploadRoot: string;
	private readonly cursorSecret = randomUUID();
	private readonly ingestion: IngestService;

	constructor(
		private readonly db: AppDatabase,
		private readonly artifacts: ArtifactStore,
		uploadRoot = join(artifacts.directory, "attachment-uploads"),
	) {
		this.uploadRoot = uploadRoot;
		this.ingestion = new IngestService(artifacts);
		mkdirSync(uploadRoot, { recursive: true });
		this.recoverUploads();
		this.cleanupAbandonedDrafts();
	}

	listUploads(conversationId: string) {
		return [...this.uploads.values()]
			.filter(
				(upload) => upload.conversationId === conversationId && upload.expiresAt >= Date.now(),
			)
			.map((upload) => {
				let receivedBytes = 0;
				let totalBytes = 0;
				let fileCount = 0;
				for (const [index, entry] of upload.entries.entries()) {
					if (entry.entryKind !== "file") continue;
					const stat = lstatSync(this.uploadPartPath(upload.uploadId, index));
					if (!stat.isFile() || stat.isSymbolicLink())
						throw { kind: "unavailable", reason: "attachment_upload_file_invalid" };
					receivedBytes += stat.size;
					totalBytes += entry.bytes ?? 0;
					fileCount++;
				}
				return {
					uploadId: upload.uploadId,
					name: upload.name,
					kind: upload.kind,
					receivedBytes,
					totalBytes,
					fileCount,
				};
			});
	}

	startUpload(params: {
		conversationId: string;
		kind: "file" | "folder";
		name: string;
		entries: UploadEntry[];
	}): string {
		const entries = validateUploadEntries(params.kind, params.entries);
		const uploadId = randomUUID();
		const createdAt = Date.now();
		const manifest: UploadManifest = {
			version: 1,
			uploadId,
			conversationId: params.conversationId,
			kind: params.kind,
			name: params.name.normalize("NFC"),
			entries,
			createdAt,
			expiresAt: createdAt + UPLOAD_TTL_MS,
		};
		const staging = join(this.uploadRoot, `.tmp-${uploadId}`);
		const destination = join(this.uploadRoot, uploadId);
		try {
			mkdirSync(join(staging, "files"), { recursive: true, mode: 0o700 });
			for (const [index, entry] of entries.entries()) {
				if (entry.entryKind === "file") {
					writeFileSync(join(staging, "files", `${index}.part`), "", {
						flag: "wx",
						mode: 0o600,
					});
				}
			}
			writeManifest(staging, manifest);
			renameSync(staging, destination);
			this.uploads.set(uploadId, manifest);
			return uploadId;
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			throw error;
		}
	}

	cancelUpload(conversationId: string, uploadId: string): void {
		const upload = this.uploads.get(uploadId);
		if (!upload || upload.conversationId !== conversationId) {
			throw { kind: "not_found", reason: "attachment_upload_not_found" };
		}
		this.removeUpload(uploadId);
	}

	appendChunk(params: {
		conversationId: string;
		uploadId: string;
		fileIndex: number;
		offset: number;
		base64: string;
	}): void {
		const upload = this.requireUpload(params.conversationId, params.uploadId);
		const entry = upload.entries[params.fileIndex];
		if (!entry || entry.entryKind !== "file" || typeof entry.bytes !== "number") {
			throw { kind: "validation_failed", reason: "attachment_upload_file_invalid" };
		}
		const chunk = Buffer.from(params.base64, "base64");
		if (
			chunk.byteLength === 0 ||
			chunk.byteLength > MAX_CHUNK_BYTES ||
			chunk.toString("base64").replace(/=+$/, "") !== params.base64.replace(/=+$/, "")
		) {
			throw { kind: "validation_failed", reason: "attachment_chunk_invalid" };
		}
		const part = this.uploadPartPath(upload.uploadId, params.fileIndex);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const fd = openSync(part, constants.O_WRONLY | constants.O_APPEND | noFollow);
		try {
			const stat = fstatSync(fd);
			if (
				!stat.isFile() ||
				params.offset !== stat.size ||
				stat.size + chunk.byteLength > entry.bytes
			) {
				throw { kind: "validation_failed", reason: "attachment_chunk_offset_invalid" };
			}
			let written = 0;
			while (written < chunk.byteLength) {
				written += writeSync(fd, chunk, written, chunk.byteLength - written);
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	async completeUpload(
		conversationId: string,
		uploadId: string,
	): Promise<ConversationAttachmentSummary> {
		const upload = this.requireUpload(conversationId, uploadId);
		for (const [index, entry] of upload.entries.entries()) {
			if (entry.entryKind !== "file") continue;
			const stat = lstatSync(this.uploadPartPath(uploadId, index));
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) {
				throw { kind: "validation_failed", reason: "attachment_upload_incomplete" };
			}
		}
		const attachment = await this.createSnapshotFromPaths({
			conversationId,
			kind: upload.kind,
			name: upload.name,
			entries: upload.entries.map(
				(entry, index): StoredImportEntry =>
					entry.entryKind === "directory"
						? { entryKind: "directory", relativePath: entry.relativePath }
						: {
								entryKind: "file",
								relativePath: entry.relativePath,
								sourcePath: this.uploadPartPath(uploadId, index),
								mime: entry.mime ?? "application/octet-stream",
							},
			),
		});
		this.removeUpload(uploadId);
		return attachment;
	}

	private requireUpload(conversationId: string, uploadId: string): UploadManifest {
		const upload = this.uploads.get(uploadId);
		if (!upload || upload.conversationId !== conversationId || upload.expiresAt < Date.now()) {
			if (upload?.expiresAt && upload.expiresAt < Date.now()) this.removeUpload(uploadId);
			throw { kind: "not_found", reason: "attachment_upload_not_found" };
		}
		return upload;
	}

	private uploadPartPath(uploadId: string, fileIndex: number): string {
		if (!/^[0-9a-f-]{36}$/.test(uploadId) || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
			throw { kind: "validation_failed", reason: "attachment_upload_file_invalid" };
		}
		return join(this.uploadRoot, uploadId, "files", `${fileIndex}.part`);
	}

	private removeUpload(uploadId: string): void {
		this.uploads.delete(uploadId);
		rmSync(join(this.uploadRoot, uploadId), { recursive: true, force: true });
	}

	private recoverUploads(): void {
		for (const dirent of readdirSync(this.uploadRoot, { withFileTypes: true })) {
			const sessionPath = join(this.uploadRoot, dirent.name);
			if (
				dirent.isSymbolicLink() ||
				!dirent.isDirectory() ||
				dirent.name.startsWith(".tmp-") ||
				!/^[0-9a-f-]{36}$/.test(dirent.name)
			) {
				rmSync(sessionPath, { recursive: true, force: true });
				continue;
			}
			try {
				const manifestPath = join(sessionPath, "manifest.json");
				const manifestStat = lstatSync(manifestPath);
				if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
					throw new Error("attachment_upload_manifest_invalid");
				}
				const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
				const manifest = validateManifest(parsed, dirent.name);
				if (manifest.expiresAt < Date.now()) {
					rmSync(sessionPath, { recursive: true, force: true });
					continue;
				}
				const expectedParts = new Set(
					manifest.entries.flatMap((entry, index) =>
						entry.entryKind === "file" ? [`${index}.part`] : [],
					),
				);
				const filesPath = join(sessionPath, "files");
				const filesStat = lstatSync(filesPath);
				if (!filesStat.isDirectory() || filesStat.isSymbolicLink()) {
					throw new Error("attachment_upload_manifest_invalid");
				}
				for (const part of readdirSync(filesPath, { withFileTypes: true })) {
					if (part.isSymbolicLink() || !part.isFile() || !expectedParts.delete(part.name)) {
						throw new Error("attachment_upload_manifest_invalid");
					}
					const index = Number.parseInt(part.name, 10);
					const entry = manifest.entries[index];
					const stat = lstatSync(join(filesPath, part.name));
					if (
						entry?.entryKind !== "file" ||
						typeof entry.bytes !== "number" ||
						stat.size > entry.bytes
					) {
						throw new Error("attachment_upload_manifest_invalid");
					}
				}
				if (expectedParts.size !== 0) throw new Error("attachment_upload_manifest_invalid");
				this.uploads.set(manifest.uploadId, manifest);
			} catch {
				rmSync(sessionPath, { recursive: true, force: true });
			}
		}
	}

	private cleanupAbandonedDrafts(): void {
		const cutoff = new Date(Date.now() - DRAFT_TTL_MS).toISOString().replace("T", " ").slice(0, 19);
		this.db
			.delete(conversationAttachments)
			.where(
				and(
					isNull(conversationAttachments.originEntryId),
					ne(conversationAttachments.kind, "generated"),
					lt(conversationAttachments.createdAt, cutoff),
				),
			)
			.run();
	}

	private async createSnapshotFromPaths(params: {
		conversationId: string;
		kind: "file" | "folder" | "generated";
		name: string;
		entries: StoredImportEntry[];
		producerRunId?: string;
		maxFileBytes?: number;
		maxRootBytes?: number;
	}): Promise<ConversationAttachmentSummary> {
		type StoredEntry =
			| { entryKind: "directory"; relativePath: string }
			| { entryKind: "symlink"; relativePath: string; linkTarget: string }
			| {
					entryKind: "file";
					relativePath: string;
					artifact: ArtifactRecord;
					mime: string;
					materialKind: string;
					extractedText?: string;
					extractionError?: string;
			  };
		const seen = new Set<string>();
		const attachmentId = randomUUID();
		const stored: StoredEntry[] = [];
		let totalBytes = 0;
		let fileCount = 0;
		for (const entry of params.entries) {
			const relativePath = normalizeRelativePath(entry.relativePath);
			const collisionKey = relativePath.toLocaleLowerCase("en-US");
			if (seen.has(collisionKey)) {
				throw { kind: "validation_failed", reason: "attachment_path_collision" };
			}
			seen.add(collisionKey);
			if (entry.entryKind === "directory") {
				stored.push({ entryKind: "directory", relativePath });
				continue;
			}
			if (entry.entryKind === "symlink") {
				validateRelativeLink(relativePath, entry.linkTarget);
				stored.push({
					entryKind: "symlink",
					relativePath,
					linkTarget: entry.linkTarget,
				});
				continue;
			}
			let artifact: ArtifactRecord;
			try {
				const maxFileBytes = params.maxFileBytes ?? MAX_FILE_BYTES;
				const maxRootBytes = params.maxRootBytes ?? MAX_ROOT_BYTES;
				artifact = this.artifacts.createFromPathSync({
					logicalName: relativePath.split("/").at(-1) ?? params.name,
					path: entry.sourcePath,
					mime: entry.mime,
					producerRunId: params.producerRunId,
					maxBytes: Math.min(maxFileBytes, maxRootBytes - totalBytes),
				});
			} catch (error) {
				if (error instanceof ArtifactCorruptedError) throw error;
				if (error instanceof Error && error.message === "artifact_source_too_large") {
					throw { kind: "validation_failed", reason: "attachment_root_too_large" };
				}
				throw { kind: "validation_failed", reason: "attachment_source_changed" };
			}
			this.artifacts.markVerified(artifact.id);
			totalBytes += artifact.bytes;
			fileCount += 1;
			const extraction = await this.extractArtifact(
				artifact.id,
				relativePath.split("/").at(-1) ?? params.name,
			);
			stored.push({
				entryKind: "file",
				relativePath,
				artifact,
				mime: extraction.mime,
				materialKind: extraction.materialKind,
				...(extraction.extractedText !== undefined
					? { extractedText: extraction.extractedText }
					: {}),
				...(extraction.extractionError ? { extractionError: extraction.extractionError } : {}),
			});
		}
		if (fileCount === 0) {
			throw { kind: "validation_failed", reason: "attachment_file_count_invalid" };
		}
		this.db.transaction((tx) => {
			tx.insert(conversationAttachments)
				.values({
					id: attachmentId,
					conversationId: params.conversationId,
					kind: params.kind,
					name: params.name.normalize("NFC"),
					totalBytes,
					fileCount,
				})
				.run();
			for (const entry of stored) {
				tx.insert(conversationAttachmentFiles)
					.values(
						entry.entryKind === "file"
							? {
									id: randomUUID(),
									attachmentId,
									entryKind: "file",
									relativePath: entry.relativePath,
									artifactId: entry.artifact.id,
									mime: entry.mime,
									materialKind: entry.materialKind,
									bytes: entry.artifact.bytes,
									sha256: entry.artifact.sha256,
									extractedText: entry.extractedText ?? null,
									extractionError: entry.extractionError ?? null,
								}
							: {
									id: randomUUID(),
									attachmentId,
									entryKind: entry.entryKind,
									relativePath: entry.relativePath,
									linkTarget: entry.entryKind === "symlink" ? entry.linkTarget : null,
								},
					)
					.run();
			}
		});
		return {
			id: attachmentId,
			name: params.name.normalize("NFC"),
			kind: params.kind,
			bytes: totalBytes,
			fileCount,
		};
	}

	private async extractArtifact(
		artifactId: string,
		logicalName: string,
	): Promise<{
		mime: string;
		materialKind: string;
		extractedText?: string;
		extractionError?: string;
	}> {
		const buffer = this.artifacts.readBlob(artifactId);
		if (!buffer) {
			return {
				mime: "application/octet-stream",
				materialKind: "unknown",
				extractionError: "attachment_content_unavailable",
			};
		}
		const inspection = await this.ingestion.inspectBuffer({ buffer, logicalName });
		if (inspection.state !== "ready") {
			return {
				mime: inspection.mime,
				materialKind: inspection.kind,
				extractionError: `attachment_extraction_${inspection.kind}`,
			};
		}
		const parser = codecRegistry.getParser(inspection.kind === "source" ? "text" : inspection.kind);
		if (!parser) {
			return {
				mime: inspection.mime,
				materialKind: inspection.kind,
				extractionError: "attachment_extraction_unsupported",
			};
		}
		const parsed = await parser(buffer, { maxCharacters: MAX_EXTRACTED_CHARS });
		if (parsed.error) {
			return {
				mime: inspection.mime,
				materialKind: inspection.kind,
				extractionError: "attachment_extraction_failed",
			};
		}
		const extractedText =
			parsed.text ||
			(parsed.metadata ? JSON.stringify(parsed.metadata).slice(0, MAX_EXTRACTED_CHARS) : "");
		return {
			mime: inspection.mime,
			materialKind: inspection.kind,
			extractedText,
		};
	}

	createSnapshot(params: {
		conversationId: string;
		kind: "file" | "folder" | "generated";
		name: string;
		files: Array<{ relativePath: string; mime: string; buffer: Buffer }>;
		producerRunId?: string;
	}): ConversationAttachmentSummary {
		if (params.files.length === 0 || params.files.length > 20_000) {
			throw { kind: "validation_failed", reason: "attachment_file_count_invalid" };
		}
		let totalBytes = 0;
		const seen = new Set<string>();
		const attachmentId = randomUUID();
		const files = params.files.map((file) => {
			const relativePath = normalizeRelativePath(file.relativePath);
			if (seen.has(relativePath.toLocaleLowerCase("en-US"))) {
				throw { kind: "validation_failed", reason: "attachment_path_collision" };
			}
			seen.add(relativePath.toLocaleLowerCase("en-US"));
			if (file.buffer.byteLength > MAX_FILE_BYTES) {
				throw { kind: "validation_failed", reason: "attachment_file_too_large" };
			}
			totalBytes += file.buffer.byteLength;
			if (totalBytes > MAX_ROOT_BYTES) {
				throw { kind: "validation_failed", reason: "attachment_root_too_large" };
			}
			const artifact = this.artifacts.create({
				logicalName: relativePath.split("/").at(-1) ?? params.name,
				buffer: file.buffer,
				mime: file.mime,
				producerRunId: params.producerRunId,
			});
			this.artifacts.markVerified(artifact.id);
			return {
				relativePath,
				artifact,
				mime: file.mime,
				...extractBufferText(file.buffer, file.mime),
			};
		});
		this.db.transaction((tx) => {
			tx.insert(conversationAttachments)
				.values({
					id: attachmentId,
					conversationId: params.conversationId,
					kind: params.kind,
					name: params.name.normalize("NFC"),
					totalBytes,
					fileCount: files.length,
				})
				.run();
			for (const file of files) {
				tx.insert(conversationAttachmentFiles)
					.values({
						id: randomUUID(),
						attachmentId,
						entryKind: "file",
						relativePath: file.relativePath,
						artifactId: file.artifact.id,
						mime: file.mime,
						materialKind: file.materialKind,
						bytes: file.artifact.bytes,
						sha256: file.artifact.sha256,
						extractedText: file.extractedText ?? null,
						extractionError: file.extractionError ?? null,
					})
					.run();
			}
		});
		return {
			id: attachmentId,
			name: params.name.normalize("NFC"),
			kind: params.kind,
			bytes: totalBytes,
			fileCount: files.length,
		};
	}

	/** Trusted-main import: copy the selected path into conversation-owned snapshot storage. */
	async importPaths(
		conversationId: string,
		paths: string[],
	): Promise<ConversationAttachmentSummary[]> {
		if (paths.length === 0 || paths.length > MAX_ROOTS) {
			throw { kind: "validation_failed", reason: "attachment_root_count_invalid" };
		}
		const result: ConversationAttachmentSummary[] = [];
		for (const path of paths) {
			if (!isAbsolute(path)) {
				throw { kind: "validation_failed", reason: "attachment_source_path_invalid" };
			}
			const selectedStat = lstatSync(path);
			if (
				selectedStat.isSymbolicLink() ||
				(!selectedStat.isFile() && !selectedStat.isDirectory())
			) {
				throw { kind: "validation_failed", reason: "attachment_source_type_invalid" };
			}
			const canonicalPath = realpathSync(path);
			const stat = lstatSync(canonicalPath);
			if (
				stat.isSymbolicLink() ||
				(!stat.isFile() && !stat.isDirectory()) ||
				stat.dev !== selectedStat.dev ||
				stat.ino !== selectedStat.ino
			) {
				throw { kind: "validation_failed", reason: "attachment_source_changed" };
			}
			const kind = stat.isDirectory() ? ("folder" as const) : ("file" as const);
			const entries = collectImportEntries(canonicalPath, kind);
			const attachment = await this.createSnapshotFromPaths({
				conversationId,
				kind,
				name: basename(canonicalPath),
				entries,
			});
			result.push(attachment);
		}
		return result;
	}

	beginSend(conversationId: string, attachmentIds: string[]): string | undefined {
		this.assertSendable(conversationId, attachmentIds);
		if (attachmentIds.length === 0) return undefined;
		const nonce = randomUUID();
		const changed = this.db
			.update(conversationAttachments)
			.set({ sendNonce: nonce })
			.where(
				and(
					eq(conversationAttachments.conversationId, conversationId),
					inArray(conversationAttachments.id, attachmentIds),
					isNull(conversationAttachments.originEntryId),
					isNull(conversationAttachments.sendNonce),
				),
			)
			.run();
		if (changed.changes !== attachmentIds.length) {
			throw { kind: "conflict", reason: "attachment_send_race" };
		}
		return nonce;
	}

	finishSend(conversationId: string, nonce: string, originEntryId: string): void {
		this.db
			.update(conversationAttachments)
			.set({ originEntryId, sendNonce: null })
			.where(
				and(
					eq(conversationAttachments.conversationId, conversationId),
					eq(conversationAttachments.sendNonce, nonce),
				),
			)
			.run();
	}

	abortSend(conversationId: string, nonce: string): void {
		this.db
			.update(conversationAttachments)
			.set({ sendNonce: null })
			.where(
				and(
					eq(conversationAttachments.conversationId, conversationId),
					eq(conversationAttachments.sendNonce, nonce),
					isNull(conversationAttachments.originEntryId),
				),
			)
			.run();
	}

	prepareRunInputs(params: {
		conversationId: string;
		attachmentIds: string[];
		workspaceAttachmentId?: string;
		runDirectory: string;
	}): PreparedRunInputs {
		if (
			params.attachmentIds.length === 0 ||
			params.attachmentIds.length > MAX_ROOTS ||
			new Set(params.attachmentIds).size !== params.attachmentIds.length
		) {
			throw { kind: "validation_failed", reason: "attachment_ids_invalid" };
		}
		const attachments = params.attachmentIds.map((id) => {
			const row = this.db
				.select()
				.from(conversationAttachments)
				.where(
					and(
						eq(conversationAttachments.id, id),
						eq(conversationAttachments.conversationId, params.conversationId),
					),
				)
				.get();
			if (!row) throw { kind: "not_found", reason: "attachment_not_found" };
			return row;
		});
		const requestedWorkspace = params.workspaceAttachmentId
			? attachments.find((attachment) => attachment.id === params.workspaceAttachmentId)
			: undefined;
		if (
			params.workspaceAttachmentId &&
			(!requestedWorkspace || requestedWorkspace.kind === "generated")
		) {
			throw { kind: "validation_failed", reason: "workspace_attachment_invalid" };
		}
		const materialized = new Map(
			attachments.map((attachment, index) => [
				attachment.id,
				this.materialize(
					params.conversationId,
					[attachment.id],
					join(params.runDirectory, `snapshot-${index}`),
				)[0]!,
			]),
		);
		const inputs = attachments.map((attachment) => ({
			attachmentId: attachment.id,
			name: attachment.name,
			path: materialized.get(attachment.id)!,
			source: "snapshot" as const,
		}));
		const workspaceInput =
			(params.workspaceAttachmentId
				? inputs.find((input) => input.attachmentId === params.workspaceAttachmentId)
				: inputs.find(
						(input) =>
							attachments.find((attachment) => attachment.id === input.attachmentId)?.kind ===
							"folder",
					)) ?? undefined;
		const workspaceKind = workspaceInput
			? attachments.find((attachment) => attachment.id === workspaceInput.attachmentId)?.kind
			: undefined;
		const outputDirectory = join(params.runDirectory, "outputs");
		mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
		chmodSync(outputDirectory, 0o700);
		return {
			workspace: workspaceInput
				? workspaceKind === "file"
					? dirname(workspaceInput.path)
					: workspaceInput.path
				: params.runDirectory,
			outputDirectory,
			inputs,
		};
	}

	async captureOutputs(
		conversationId: string,
		runId: string,
		outputDirectory: string,
	): Promise<ConversationAttachmentSummary[]> {
		let entries: StoredImportEntry[];
		try {
			if (readdirSync(outputDirectory).length === 0) return [];
			entries = collectImportEntries(outputDirectory, "folder", {
				maxFiles: 50,
				maxFileBytes: 50 * 1024 * 1024,
				maxBytes: 200 * 1024 * 1024,
				allowSymlinks: false,
			});
		} catch {
			throw { kind: "conflict", reason: "output_snapshot_failed" };
		}
		return [
			await this.createSnapshotFromPaths({
				conversationId,
				kind: "generated",
				name: "Generated outputs",
				entries,
				producerRunId: runId,
				maxFileBytes: 50 * 1024 * 1024,
				maxRootBytes: 200 * 1024 * 1024,
			}),
		];
	}

	generatedForRun(conversationId: string, runId: string): ConversationAttachmentSummary[] {
		const rows = this.db
			.select({ attachment: conversationAttachments })
			.from(conversationAttachments)
			.innerJoin(
				conversationAttachmentFiles,
				eq(conversationAttachmentFiles.attachmentId, conversationAttachments.id),
			)
			.innerJoin(artifacts, eq(artifacts.id, conversationAttachmentFiles.artifactId))
			.where(
				and(
					eq(conversationAttachments.conversationId, conversationId),
					eq(conversationAttachments.kind, "generated"),
					eq(artifacts.producerRunId, runId),
				),
			)
			.all();
		const unique = new Map(rows.map(({ attachment }) => [attachment.id, attachment]));
		return [...unique.values()].map((attachment) => ({
			id: attachment.id,
			name: attachment.name,
			kind: "generated",
			bytes: attachment.totalBytes,
			fileCount: attachment.fileCount,
			...(attachment.originEntryId ? { originEntryId: attachment.originEntryId } : {}),
		}));
	}

	bindGenerated(conversationId: string, attachmentIds: string[], originEntryId: string): void {
		if (attachmentIds.length === 0) return;
		this.db
			.update(conversationAttachments)
			.set({ originEntryId })
			.where(
				and(
					eq(conversationAttachments.conversationId, conversationId),
					inArray(conversationAttachments.id, attachmentIds),
					eq(conversationAttachments.kind, "generated"),
					isNull(conversationAttachments.originEntryId),
				),
			)
			.run();
	}

	assertSendable(conversationId: string, attachmentIds: string[]): void {
		if (attachmentIds.length > MAX_ROOTS || new Set(attachmentIds).size !== attachmentIds.length) {
			throw { kind: "validation_failed", reason: "attachment_root_count_invalid" };
		}
		let totalBytes = 0;
		for (const attachmentId of attachmentIds) {
			const attachment = this.db
				.select()
				.from(conversationAttachments)
				.where(
					and(
						eq(conversationAttachments.id, attachmentId),
						eq(conversationAttachments.conversationId, conversationId),
					),
				)
				.get();
			if (
				!attachment ||
				attachment.kind === "generated" ||
				attachment.originEntryId !== null ||
				attachment.sendNonce !== null
			) {
				throw { kind: "not_found", reason: "attachment_not_sendable" };
			}
			totalBytes += attachment.totalBytes;
			if (totalBytes > MAX_ROOT_BYTES) {
				throw { kind: "validation_failed", reason: "attachment_send_too_large" };
			}
		}
	}

	resolveFile(
		conversationId: string,
		attachmentId: string,
		relativePath?: string,
	): {
		relativePath: string;
		mime: string;
		name: string;
		bytes: number;
	} {
		const resolved = this.resolveStoredFile(conversationId, attachmentId, relativePath);
		return {
			relativePath: resolved.relativePath,
			mime: resolved.mime,
			name: resolved.name,
			bytes: resolved.bytes,
		};
	}

	readFile(
		conversationId: string,
		attachmentId: string,
		relativePath?: string,
	): {
		relativePath: string;
		mime: string;
		name: string;
		buffer: Buffer;
	} {
		const resolved = this.resolveStoredFile(conversationId, attachmentId, relativePath);
		const buffer = this.artifacts.readBlob(resolved.artifactId);
		if (!buffer) throw { kind: "not_found", reason: "attachment_content_unavailable" };
		return {
			relativePath: resolved.relativePath,
			mime: resolved.mime,
			name: resolved.name,
			buffer,
		};
	}

	private resolveStoredFile(
		conversationId: string,
		attachmentId: string,
		relativePath?: string,
	): {
		artifactId: string;
		relativePath: string;
		mime: string;
		name: string;
		bytes: number;
	} {
		const attachment = this.db
			.select()
			.from(conversationAttachments)
			.where(
				and(
					eq(conversationAttachments.id, attachmentId),
					eq(conversationAttachments.conversationId, conversationId),
				),
			)
			.get();
		if (!attachment) throw { kind: "not_found", reason: "attachment_not_found" };
		const files = this.db
			.select()
			.from(conversationAttachmentFiles)
			.where(eq(conversationAttachmentFiles.attachmentId, attachmentId))
			.orderBy(asc(conversationAttachmentFiles.relativePath))
			.all();
		if (!relativePath && files.length !== 1) {
			throw { kind: "not_found", reason: "attachment_file_ambiguous" };
		}
		const file = files.find(
			(candidate) => candidate.relativePath === (relativePath ?? files[0]?.relativePath),
		);
		if (!file || file.entryKind !== "file" || !file.artifactId) {
			throw { kind: "not_found", reason: "attachment_file_not_found" };
		}
		const artifact = this.artifacts.get(file.artifactId);
		if (!artifact) throw { kind: "not_found", reason: "attachment_content_unavailable" };
		return {
			artifactId: file.artifactId,
			relativePath: file.relativePath,
			mime: file.mime || artifact.mime || "application/octet-stream",
			name: artifact.logicalName,
			bytes: file.bytes ?? artifact.bytes,
		};
	}

	list(
		conversationId: string,
		attachmentId?: string,
		includeUnboundUserDrafts = false,
	): ConversationAttachmentSummary[] {
		const rows = this.db
			.select()
			.from(conversationAttachments)
			.where(eq(conversationAttachments.conversationId, conversationId))
			.orderBy(asc(conversationAttachments.createdAt))
			.all()
			.filter((row) =>
				attachmentId
					? row.id === attachmentId
					: includeUnboundUserDrafts || row.kind === "generated" || row.originEntryId !== null,
			);
		if (attachmentId && rows.length === 0) {
			throw { kind: "not_found", reason: "attachment_not_found" };
		}
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			kind: row.kind,
			bytes: row.totalBytes,
			fileCount: row.fileCount,
			...(row.originEntryId ? { originEntryId: row.originEntryId } : {}),
		}));
	}
	semanticRead(params: {
		conversationId: string;
		attachmentId: string;
		relativePath?: string;
		query?: string;
		cursor?: string;
		contentLimit?: number;
	}): {
		mode: "semantic";
		files?: Array<{
			relativePath: string;
			entryKind: "file" | "directory" | "symlink";
			mime?: string;
			bytes?: number;
			readable: boolean;
			error?: string;
		}>;
		content?: string;
		hits?: Array<{ relativePath: string; excerpt: string }>;
		error?: string;
		nextCursor?: string;
	} {
		const attachment = this.db
			.select()
			.from(conversationAttachments)
			.where(
				and(
					eq(conversationAttachments.id, params.attachmentId),
					eq(conversationAttachments.conversationId, params.conversationId),
				),
			)
			.get();
		if (!attachment) throw { kind: "not_found", reason: "attachment_not_found" };
		const files = this.db
			.select()
			.from(conversationAttachmentFiles)
			.where(eq(conversationAttachmentFiles.attachmentId, params.attachmentId))
			.orderBy(asc(conversationAttachmentFiles.relativePath))
			.all();

		if (params.query) {
			const cursorArgs = `search:${params.conversationId}:${params.attachmentId}:${params.query}`;
			const start = params.cursor ? this.decodeCursor(params.cursor, cursorArgs) : 0;
			const needle = params.query.toLocaleLowerCase("en-US");
			const hits: Array<{ relativePath: string; excerpt: string }> = [];
			let nextIndex: number | undefined;
			for (let index = start; index < files.length; index += 1) {
				const file = files[index]!;
				if (file.entryKind !== "file") continue;
				const pathMatch = file.relativePath.toLocaleLowerCase("en-US").indexOf(needle);
				const textMatch = file.extractedText?.toLocaleLowerCase("en-US").indexOf(needle) ?? -1;
				if (pathMatch < 0 && textMatch < 0) continue;
				if (hits.length === MAX_SEARCH_HITS) {
					nextIndex = index;
					break;
				}
				const excerptStart = textMatch >= 0 ? Math.max(0, textMatch - 256) : 0;
				hits.push({
					relativePath: file.relativePath,
					excerpt:
						textMatch >= 0
							? file.extractedText!.slice(excerptStart, excerptStart + 1024)
							: file.relativePath.slice(0, 1024),
				});
			}
			return {
				mode: "semantic",
				hits,
				...(nextIndex !== undefined
					? { nextCursor: this.encodeCursor(nextIndex, cursorArgs) }
					: {}),
			};
		}

		if (!params.relativePath && (attachment.kind === "folder" || attachment.kind === "generated")) {
			const cursorArgs = `folder:${params.conversationId}:${params.attachmentId}`;
			const start = params.cursor ? this.decodeCursor(params.cursor, cursorArgs) : 0;
			const page = files.slice(start, start + MAX_FOLDER_PAGE);
			const next = start + page.length;
			return {
				mode: "semantic",
				files: page.map((file) => ({
					relativePath: file.relativePath,
					entryKind: file.entryKind as "file" | "directory" | "symlink",
					...(file.mime ? { mime: file.mime } : {}),
					...(file.bytes !== null ? { bytes: file.bytes } : {}),
					readable: file.entryKind === "file" && file.extractedText !== null,
					...(file.entryKind === "file" && file.extractionError
						? { error: file.extractionError }
						: {}),
				})),
				...(next < files.length ? { nextCursor: this.encodeCursor(next, cursorArgs) } : {}),
			};
		}

		const file = files.find(
			(candidate) => candidate.relativePath === (params.relativePath ?? files[0]?.relativePath),
		);
		if (!file || file.entryKind !== "file") {
			return { mode: "semantic", error: "attachment_file_unreadable" };
		}
		if (file.extractedText !== null) {
			const contentLimit = Math.min(
				SEMANTIC_CONTENT_CHARS,
				Math.max(1, params.contentLimit ?? SEMANTIC_CONTENT_CHARS),
			);
			const cursorArgs = `file:${params.conversationId}:${params.attachmentId}:${file.relativePath}:${contentLimit}`;
			const start = params.cursor ? this.decodeCursor(params.cursor, cursorArgs) : 0;
			const next = Math.min(file.extractedText.length, start + contentLimit);
			return {
				mode: "semantic",
				content: file.extractedText.slice(start, next),
				...(next < file.extractedText.length
					? { nextCursor: this.encodeCursor(next, cursorArgs) }
					: {}),
			};
		}
		return {
			mode: "semantic",
			error: file.extractionError ?? "attachment_content_unavailable",
		};
	}

	readForRole(params: {
		conversationId: string;
		attachmentId: string;
		relativePath?: string;
		query?: string;
		cursor?: string;
	}): {
		files?: Array<{
			relativePath: string;
			entryKind: "file" | "directory" | "symlink";
			readable: boolean;
		}>;
		content?: string;
		hits?: Array<{ relativePath: string; excerpt: string }>;
		error?: string;
		nextCursor?: string;
	} {
		const result = this.semanticRead({ ...params, contentLimit: ROLE_CONTENT_CHARS });
		return {
			...(result.files
				? {
						files: result.files.map((file) => ({
							relativePath: file.relativePath,
							entryKind: file.entryKind,
							readable: file.readable,
						})),
					}
				: {}),
			...(result.content !== undefined ? { content: result.content } : {}),
			...(result.hits ? { hits: result.hits } : {}),
			...(result.error ? { error: result.error } : {}),
			...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
		};
	}

	readBytes(params: {
		conversationId: string;
		attachmentId: string;
		relativePath?: string;
		offset: number;
		length: number;
	}): {
		mode: "bytes";
		relativePath: string;
		mime: string;
		base64: string;
		nextOffset: number;
		eof: boolean;
	} {
		const resolved = this.resolveStoredFile(
			params.conversationId,
			params.attachmentId,
			params.relativePath,
		);
		const range = this.artifacts.readBlobRange(resolved.artifactId, params.offset, params.length);
		if (!range) throw { kind: "not_found", reason: "attachment_content_unavailable" };
		return {
			mode: "bytes",
			relativePath: resolved.relativePath,
			mime: resolved.mime,
			base64: range.buffer.toString("base64"),
			nextOffset: range.nextOffset,
			eof: range.eof,
		};
	}

	private encodeCursor(offset: number, args: string): string {
		const payload = `${offset}:${createHash("sha256").update(this.cursorSecret).update(args).update(String(offset)).digest("base64url")}`;
		return Buffer.from(payload, "utf8").toString("base64url");
	}

	private decodeCursor(cursor: string, args: string): number {
		let payload: string;
		try {
			payload = Buffer.from(cursor, "base64url").toString("utf8");
		} catch {
			throw { kind: "validation_failed", reason: "attachment_cursor_invalid" };
		}
		const separator = payload.indexOf(":");
		const offset = Number(payload.slice(0, separator));
		const expected =
			Number.isSafeInteger(offset) && offset >= 0 ? this.encodeCursor(offset, args) : "";
		if (!expected || expected !== cursor) {
			throw { kind: "validation_failed", reason: "attachment_cursor_invalid" };
		}
		return offset;
	}

	materialize(conversationId: string, attachmentIds: string[], destination: string): string[] {
		const roots: string[] = [];
		for (const attachmentId of attachmentIds) {
			const attachment = this.db
				.select()
				.from(conversationAttachments)
				.where(
					and(
						eq(conversationAttachments.id, attachmentId),
						eq(conversationAttachments.conversationId, conversationId),
					),
				)
				.get();
			if (!attachment) throw { kind: "not_found", reason: "attachment_not_found" };
			const root = join(destination, "inputs", attachment.id);
			mkdirSync(root, { recursive: true });
			const entries = this.db
				.select()
				.from(conversationAttachmentFiles)
				.where(eq(conversationAttachmentFiles.attachmentId, attachment.id))
				.orderBy(asc(conversationAttachmentFiles.relativePath))
				.all();
			try {
				for (const entry of entries) {
					if (entry.entryKind !== "directory") continue;
					mkdirSync(materializedPath(root, entry.relativePath), { recursive: true });
				}
				for (const entry of entries) {
					if (entry.entryKind !== "file" || !entry.artifactId) continue;
					const blob = this.artifacts.readBlob(entry.artifactId);
					if (!blob) throw new Error("attachment_blob_missing");
					const target = materializedPath(root, entry.relativePath);
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, blob, { flag: "wx" });
				}
				for (const entry of entries) {
					if (entry.entryKind !== "symlink" || !entry.linkTarget) continue;
					validateRelativeLink(entry.relativePath, entry.linkTarget);
					const target = materializedPath(root, entry.relativePath);
					mkdirSync(dirname(target), { recursive: true });
					symlinkSync(entry.linkTarget, target);
				}
			} catch (error) {
				if (error instanceof ArtifactCorruptedError) throw error;
				throw { kind: "conflict", reason: "attachment_materialization_failed" };
			}
			roots.push(root);
		}
		if (roots.length > 0) {
			try {
				makeTreeReadOnly(destination);
			} catch {
				throw { kind: "conflict", reason: "attachment_materialization_failed" };
			}
		}
		return roots;
	}

	discard(conversationId: string, attachmentId: string): void {
		const result = this.db
			.delete(conversationAttachments)
			.where(
				and(
					eq(conversationAttachments.id, attachmentId),
					eq(conversationAttachments.conversationId, conversationId),
					isNull(conversationAttachments.originEntryId),
				),
			)
			.run();
		if (result.changes !== 1) throw { kind: "conflict", reason: "attachment_not_discardable" };
	}
}

function makeTreeReadOnly(path: string): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return;
	if (!stat.isDirectory()) {
		chmodSync(path, 0o400);
		return;
	}
	for (const child of readdirSync(path)) makeTreeReadOnly(join(path, child));
	chmodSync(path, 0o500);
}

function validateUploadEntries(kind: "file" | "folder", rawEntries: UploadEntry[]): UploadEntry[] {
	if (rawEntries.length === 0 || rawEntries.length > MAX_UPLOAD_ENTRIES) {
		throw { kind: "validation_failed", reason: "attachment_file_count_invalid" };
	}
	const entries = rawEntries.map((entry) => {
		if (entry.entryKind !== "file" && entry.entryKind !== "directory") {
			throw { kind: "validation_failed", reason: "attachment_upload_file_invalid" };
		}
		const relativePath = normalizeRelativePath(entry.relativePath);
		if (
			entry.entryKind === "file" &&
			(!Number.isSafeInteger(entry.bytes) || entry.bytes === undefined || entry.bytes < 0)
		) {
			throw { kind: "validation_failed", reason: "attachment_upload_file_invalid" };
		}
		if (entry.entryKind === "directory" && entry.bytes !== undefined) {
			throw { kind: "validation_failed", reason: "attachment_upload_file_invalid" };
		}
		return {
			entryKind: entry.entryKind,
			relativePath,
			...(entry.mime ? { mime: entry.mime } : {}),
			...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
		};
	});
	const files = entries.filter((entry) => entry.entryKind === "file");
	if (files.length === 0 || (kind === "file" && (files.length !== 1 || entries.length !== 1))) {
		throw { kind: "validation_failed", reason: "attachment_file_count_invalid" };
	}
	let total = 0;
	const seen = new Set<string>();
	const entryKindByPath = new Map(
		entries.map((entry) => [entry.relativePath.toLocaleLowerCase("en-US"), entry.entryKind]),
	);
	for (const entry of entries) {
		const collisionKey = entry.relativePath.toLocaleLowerCase("en-US");
		if (seen.has(collisionKey)) {
			throw { kind: "validation_failed", reason: "attachment_path_collision" };
		}
		seen.add(collisionKey);
		for (
			let parent = posix.dirname(entry.relativePath);
			parent !== ".";
			parent = posix.dirname(parent)
		) {
			if (entryKindByPath.get(parent.toLocaleLowerCase("en-US")) === "file") {
				throw { kind: "validation_failed", reason: "attachment_path_collision" };
			}
		}
		if (entry.entryKind === "file") {
			if (entry.bytes! > MAX_FILE_BYTES) {
				throw { kind: "validation_failed", reason: "attachment_file_too_large" };
			}
			total += entry.bytes!;
			if (total > MAX_ROOT_BYTES) {
				throw { kind: "validation_failed", reason: "attachment_root_too_large" };
			}
		}
	}
	return entries;
}

function validateManifest(value: unknown, directoryName: string): UploadManifest {
	if (!value || typeof value !== "object") throw new Error("attachment_upload_manifest_invalid");
	const candidate = value as Partial<UploadManifest>;
	if (
		candidate.version !== 1 ||
		candidate.uploadId !== directoryName ||
		typeof candidate.conversationId !== "string" ||
		(candidate.kind !== "file" && candidate.kind !== "folder") ||
		typeof candidate.name !== "string" ||
		!Array.isArray(candidate.entries) ||
		typeof candidate.createdAt !== "number" ||
		typeof candidate.expiresAt !== "number" ||
		candidate.expiresAt - candidate.createdAt !== UPLOAD_TTL_MS
	) {
		throw new Error("attachment_upload_manifest_invalid");
	}
	return {
		version: 1,
		uploadId: directoryName,
		conversationId: candidate.conversationId,
		kind: candidate.kind,
		name: candidate.name.normalize("NFC"),
		entries: validateUploadEntries(candidate.kind, candidate.entries as UploadEntry[]),
		createdAt: candidate.createdAt,
		expiresAt: candidate.expiresAt,
	};
}

function writeManifest(sessionPath: string, manifest: UploadManifest): void {
	const temporary = join(sessionPath, "manifest.json.tmp");
	const destination = join(sessionPath, "manifest.json");
	writeFileSync(temporary, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
	const fd = openSync(temporary, constants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, destination);
}

function validateRelativeLink(relativePath: string, linkTarget: string): void {
	if (
		!linkTarget ||
		linkTarget.includes("\0") ||
		linkTarget.includes("\\") ||
		linkTarget.startsWith("/") ||
		/^[A-Za-z]:/.test(linkTarget)
	) {
		throw { kind: "validation_failed", reason: "attachment_symlink_invalid" };
	}
	const parent = posix.dirname(normalizeRelativePath(relativePath));
	const resolved = posix.resolve("/attachment-root", parent === "." ? "" : parent, linkTarget);
	if (resolved !== "/attachment-root" && !resolved.startsWith("/attachment-root/")) {
		throw { kind: "validation_failed", reason: "attachment_symlink_escape" };
	}
}

function materializedPath(root: string, relativePath: string): string {
	const normalized = normalizeRelativePath(relativePath);
	const target = resolve(root, ...normalized.split("/"));
	const fromRoot = relative(root, target);
	if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
		throw { kind: "validation_failed", reason: "attachment_path_invalid" };
	}
	return target;
}

function collectImportEntries(
	root: string,
	kind: "file" | "folder",
	limits: {
		maxFiles: number;
		maxFileBytes: number;
		maxBytes: number;
		allowSymlinks: boolean;
	} = {
		maxFiles: MAX_UPLOAD_ENTRIES,
		maxFileBytes: MAX_FILE_BYTES,
		maxBytes: MAX_ROOT_BYTES,
		allowSymlinks: true,
	},
): StoredImportEntry[] {
	const entries: StoredImportEntry[] = [];
	let bytes = 0;
	let fileCount = 0;
	const visit = (path: string, relativePath: string): void => {
		if (entries.length >= MAX_UPLOAD_ENTRIES) {
			throw { kind: "validation_failed", reason: "attachment_file_count_invalid" };
		}
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			if (!limits.allowSymlinks) {
				throw { kind: "validation_failed", reason: "attachment_source_type_invalid" };
			}
			const linkTarget = readlinkSync(path);
			const normalizedPath = normalizeRelativePath(relativePath);
			validateRelativeLink(normalizedPath, linkTarget);
			const target = realpathSync(path);
			const fromRoot = relative(root, target);
			if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
				throw { kind: "validation_failed", reason: "attachment_symlink_escape" };
			}
			entries.push({ entryKind: "symlink", relativePath: normalizedPath, linkTarget });
			return;
		}
		if (stat.isDirectory()) {
			if (relativePath) {
				entries.push({
					entryKind: "directory",
					relativePath: normalizeRelativePath(relativePath),
				});
			}
			for (const child of readdirSync(path).sort()) {
				visit(join(path, child), relativePath ? `${relativePath}/${child}` : child);
			}
			return;
		}
		if (!stat.isFile()) {
			throw { kind: "validation_failed", reason: "attachment_source_type_invalid" };
		}
		if (
			stat.size > limits.maxFileBytes ||
			bytes + stat.size > limits.maxBytes ||
			fileCount >= limits.maxFiles
		) {
			throw { kind: "validation_failed", reason: "attachment_root_too_large" };
		}
		bytes += stat.size;
		fileCount += 1;
		entries.push({
			entryKind: "file",
			relativePath: normalizeRelativePath(relativePath),
			sourcePath: path,
			mime: mimeForPath(path),
		});
	};
	visit(root, kind === "file" ? basename(root) : "");
	if (fileCount === 0) {
		throw { kind: "validation_failed", reason: "attachment_file_count_invalid" };
	}
	return entries;
}

function extractBufferText(
	buffer: Buffer,
	mime: string,
): { materialKind: string; extractedText?: string; extractionError?: string } {
	const materialKind = materialKindForMime(mime);
	if (materialKind === "unknown") {
		return { materialKind, extractionError: "attachment_extraction_unsupported" };
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return { materialKind, extractionError: "attachment_extraction_invalid_utf8" };
	}
	if (text.length > MAX_EXTRACTED_CHARS) {
		return { materialKind, extractionError: "attachment_extraction_too_large" };
	}
	return { materialKind, extractedText: text };
}

function materialKindForMime(mime: string): "text" | "markdown" | "csv" | "source" | "unknown" {
	if (mime === "text/markdown") return "markdown";
	if (mime === "text/csv") return "csv";
	if (mime === "application/json") return "source";
	if (mime.startsWith("text/")) return "text";
	return "unknown";
}

function normalizeRelativePath(value: string): string {
	const path = value.normalize("NFC").replaceAll("\\", "/");
	if (
		!path ||
		path.startsWith("/") ||
		/^[A-Za-z]:/.test(path) ||
		path.startsWith("//") ||
		path.includes("\0")
	) {
		throw { kind: "validation_failed", reason: "attachment_path_invalid" };
	}
	const parts = path.split("/");
	if (parts.length > 64 || parts.some((part) => !part || part === "." || part === "..")) {
		throw { kind: "validation_failed", reason: "attachment_path_invalid" };
	}
	if (Buffer.byteLength(path, "utf8") > 1024)
		throw { kind: "validation_failed", reason: "attachment_path_invalid" };
	return path;
}

function mimeForPath(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".txt":
			return "text/plain";
		case ".md":
			return "text/markdown";
		case ".json":
			return "application/json";
		case ".csv":
			return "text/csv";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
}
