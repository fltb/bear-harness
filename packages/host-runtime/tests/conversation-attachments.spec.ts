import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import { ConversationAttachmentService } from "../src/conversation-attachments/service.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-attachments-"));
	roots.push(root);
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE conversations (id TEXT PRIMARY KEY);
		CREATE TABLE runs (id TEXT PRIMARY KEY);
		CREATE TABLE artifacts (id TEXT PRIMARY KEY, logical_name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL, producer_run_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
		CREATE TABLE artifact_adoptions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, run_id TEXT NOT NULL, adopted_at TEXT NOT NULL DEFAULT (datetime('now')));
		CREATE TABLE conversation_attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, origin_entry_id TEXT, send_nonce TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, total_bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
		CREATE TABLE conversation_attachment_files (id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL, entry_kind TEXT NOT NULL, relative_path TEXT NOT NULL, artifact_id TEXT, link_target TEXT, mime TEXT, material_kind TEXT, bytes INTEGER, sha256 TEXT, extracted_text TEXT, extraction_error TEXT, UNIQUE(attachment_id, relative_path));
		INSERT INTO conversations VALUES ('conversation-1');
	`);
	const orm = drizzle({ client: db });
	const artifactStore = new ArtifactStore(orm, join(root, "artifacts"));
	const uploadRoot = join(root, "attachment-uploads");
	return {
		db,
		orm,
		root,
		uploadRoot,
		artifactStore,
		service: new ConversationAttachmentService(orm, artifactStore, uploadRoot),
	};
}

describe("ConversationAttachmentService upload sessions", () => {
	it("owns upload sessions by conversation and cancels them", () => {
		const { db, service } = fixture();
		const uploadId = service.startUpload({
			conversationId: "conversation-1",
			kind: "file",
			name: "note.txt",
			entries: [{ entryKind: "file", relativePath: "note.txt", bytes: 2, mime: "text/plain" }],
		});
		expect(uploadId).toMatch(/^[0-9a-f-]{36}$/);
		for (const conversationId of ["conversation-2", "conversation-1"] as const) {
			try {
				service.cancelUpload(conversationId, uploadId);
				if (conversationId === "conversation-1") continue;
				throw new Error("foreign cancellation unexpectedly succeeded");
			} catch (error) {
				expect(error).toMatchObject({ reason: "attachment_upload_not_found" });
			}
		}
		try {
			service.cancelUpload("conversation-1", uploadId);
			throw new Error("second cancellation unexpectedly succeeded");
		} catch (error) {
			expect(error).toMatchObject({ reason: "attachment_upload_not_found" });
		}
		db.close();
	});

	it("requires monotonic chunks and commits an immutable snapshot", async () => {
		const { db, service } = fixture();
		const uploadId = service.startUpload({
			conversationId: "conversation-1",
			kind: "file",
			name: "note.txt",
			entries: [{ entryKind: "file", relativePath: "note.txt", bytes: 5, mime: "text/plain" }],
		});
		service.appendChunk({
			conversationId: "conversation-1",
			uploadId,
			fileIndex: 0,
			offset: 0,
			base64: Buffer.from("hello").toString("base64"),
		});
		const attachment = await service.completeUpload("conversation-1", uploadId);
		expect(attachment).toMatchObject({ kind: "file", name: "note.txt", bytes: 5, fileCount: 1 });
		expect(
			service.semanticRead({
				conversationId: "conversation-1",
				attachmentId: attachment.id,
			}),
		).toEqual({ mode: "semantic", content: "hello" });
		db.close();
	});

	it("rejects out-of-order and incomplete uploads", async () => {
		const { db, service } = fixture();
		const uploadId = service.startUpload({
			conversationId: "conversation-1",
			kind: "file",
			name: "note.txt",
			entries: [{ entryKind: "file", relativePath: "note.txt", bytes: 2 }],
		});
		try {
			service.appendChunk({
				conversationId: "conversation-1",
				uploadId,
				fileIndex: 0,
				offset: 1,
				base64: "YQ==",
			});
			throw new Error("out-of-order chunk unexpectedly accepted");
		} catch (error) {
			expect(error).toMatchObject({ reason: "attachment_chunk_offset_invalid" });
		}
		try {
			await service.completeUpload("conversation-1", uploadId);
			throw new Error("incomplete upload unexpectedly committed");
		} catch (error) {
			expect(error).toMatchObject({ reason: "attachment_upload_incomplete" });
		}
		db.close();
	});
});

describe("ConversationAttachmentService disk-backed upload sessions", () => {
	it("stores chunks on disk and recovers an interrupted session", async () => {
		const { db, orm, service, artifactStore, uploadRoot } = fixture();
		const uploadId = service.startUpload({
			conversationId: "conversation-1",
			kind: "file",
			name: "note.txt",
			entries: [{ entryKind: "file", relativePath: "note.txt", bytes: 5, mime: "text/plain" }],
		});
		service.appendChunk({
			conversationId: "conversation-1",
			uploadId,
			fileIndex: 0,
			offset: 0,
			base64: Buffer.from("he").toString("base64"),
		});
		const part = join(uploadRoot, uploadId, "files", "0.part");
		expect(readFileSync(part, "utf8")).toBe("he");

		const recovered = new ConversationAttachmentService(orm, artifactStore, uploadRoot);
		recovered.appendChunk({
			conversationId: "conversation-1",
			uploadId,
			fileIndex: 0,
			offset: 2,
			base64: Buffer.from("llo").toString("base64"),
		});
		const attachment = await recovered.completeUpload("conversation-1", uploadId);
		expect(existsSync(join(uploadRoot, uploadId))).toBe(false);
		expect(
			recovered.semanticRead({
				conversationId: "conversation-1",
				attachmentId: attachment.id,
			}),
		).toEqual({ mode: "semantic", content: "hello" });
		db.close();
	});

	it("cleans expired upload sessions during startup", () => {
		const { db, orm, service, artifactStore, uploadRoot } = fixture();
		const uploadId = service.startUpload({
			conversationId: "conversation-1",
			kind: "file",
			name: "old.txt",
			entries: [{ entryKind: "file", relativePath: "old.txt", bytes: 1 }],
		});
		const manifestPath = join(uploadRoot, uploadId, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			createdAt: number;
			expiresAt: number;
		};
		manifest.createdAt = Date.now() - 2 * 60 * 60 * 1000;
		manifest.expiresAt = manifest.createdAt + 60 * 60 * 1000;
		writeFileSync(manifestPath, JSON.stringify(manifest));
		new ConversationAttachmentService(orm, artifactStore, uploadRoot);
		expect(existsSync(join(uploadRoot, uploadId))).toBe(false);
		db.close();
	});
	it("cleans unbound user drafts older than 24 hours", () => {
		const { db, orm, artifactStore, uploadRoot } = fixture();
		db.exec(`
			INSERT INTO conversation_attachments
				(id, conversation_id, kind, name, total_bytes, file_count, created_at)
			VALUES
				('old-draft', 'conversation-1', 'file', 'old.txt', 0, 1, datetime('now', '-25 hours')),
				('new-draft', 'conversation-1', 'file', 'new.txt', 0, 1, datetime('now', '-23 hours'));
		`);
		new ConversationAttachmentService(orm, artifactStore, uploadRoot);
		const rows = db.prepare("SELECT id FROM conversation_attachments ORDER BY id").all() as Array<{
			id: string;
		}>;
		expect(rows).toEqual([{ id: "new-draft" }]);
		db.close();
	});

	it("serves bounded byte ranges without semantic binary decoding", () => {
		const { db, service } = fixture();
		const attachment = service.createSnapshot({
			conversationId: "conversation-1",
			kind: "file",
			name: "binary.dat",
			files: [
				{
					relativePath: "binary.dat",
					mime: "application/octet-stream",
					buffer: Buffer.from([0xff, 0x00, 0x41]),
				},
			],
		});
		expect(
			service.semanticRead({
				conversationId: "conversation-1",
				attachmentId: attachment.id,
			}),
		).toEqual({ mode: "semantic", error: "attachment_extraction_unsupported" });
		expect(
			service.readBytes({
				conversationId: "conversation-1",
				attachmentId: attachment.id,
				offset: 1,
				length: 2,
			}),
		).toEqual({
			mode: "bytes",
			relativePath: "binary.dat",
			mime: "application/octet-stream",
			base64: Buffer.from([0x00, 0x41]).toString("base64"),
			nextOffset: 3,
			eof: true,
		});
		db.close();
	});

	it("binds deterministic cursors to semantic operation arguments", () => {
		const { db, service } = fixture();
		const content = "a".repeat(70_000);
		const attachment = service.createSnapshot({
			conversationId: "conversation-1",
			kind: "folder",
			name: "notes",
			files: [
				{ relativePath: "alpha.txt", mime: "text/plain", buffer: Buffer.from(content) },
				{ relativePath: "Needle-name.txt", mime: "text/plain", buffer: Buffer.from("none") },
			],
		});
		const first = service.semanticRead({
			conversationId: "conversation-1",
			attachmentId: attachment.id,
			relativePath: "alpha.txt",
		});
		expect(first.content).toHaveLength(65_536);
		expect(first.nextCursor).toBeTruthy();
		expect(
			service.semanticRead({
				conversationId: "conversation-1",
				attachmentId: attachment.id,
				relativePath: "alpha.txt",
				cursor: first.nextCursor,
			}).content,
		).toHaveLength(4_464);
		expect(
			service.semanticRead({
				conversationId: "conversation-1",
				attachmentId: attachment.id,
				query: "needle",
			}).hits,
		).toEqual([{ relativePath: "Needle-name.txt", excerpt: "Needle-name.txt" }]);

		const roleFirst = service.readForRole({
			conversationId: "conversation-1",
			attachmentId: attachment.id,
			relativePath: "alpha.txt",
		});
		expect(roleFirst.content).toHaveLength(12_000);
		expect(roleFirst.nextCursor).toBeTruthy();
		expect(() =>
			service.readForRole({
				conversationId: "conversation-1",
				attachmentId: attachment.id,
				query: "different",
				cursor: roleFirst.nextCursor,
			}),
		).toThrow();
		db.close();
	});
});

describe("ConversationAttachmentService path imports", () => {
	it("persists and safely materializes relative symlinks", async () => {
		const { db, root, service } = fixture();
		const source = join(root, "source");
		mkdirSync(join(source, "links"), { recursive: true });
		writeFileSync(join(source, "note.txt"), "hello");
		symlinkSync("../note.txt", join(source, "links", "note-link"));

		const [attachment] = await service.importPaths("conversation-1", [source]);
		const listing = service.semanticRead({
			conversationId: "conversation-1",
			attachmentId: attachment!.id,
		});
		expect(listing.files).toContainEqual({
			relativePath: "links/note-link",
			entryKind: "symlink",
			readable: false,
		});
		const [materialized] = service.materialize(
			"conversation-1",
			[attachment!.id],
			join(root, "run"),
		);
		expect(readlinkSync(join(materialized!, "links", "note-link"))).toBe("../note.txt");
		expect(readFileSync(join(materialized!, "links", "note-link"), "utf8")).toBe("hello");
		db.close();
	});

	it("rejects symlinks that escape the imported root", async () => {
		const { db, root, service } = fixture();
		const source = join(root, "source");
		mkdirSync(source);
		writeFileSync(join(root, "outside.txt"), "secret");
		symlinkSync("../outside.txt", join(source, "escape"));
		await expect(service.importPaths("conversation-1", [source])).rejects.toMatchObject({
			reason: "attachment_symlink_escape",
		});
		db.close();
	});

	it("rejects final-component symlinks in artifact path ingestion", async () => {
		const { db, root, artifactStore, service } = fixture();
		const target = join(root, "target.txt");
		const link = join(root, "link.txt");
		writeFileSync(target, "hello");
		symlinkSync("target.txt", link);
		await expect(
			artifactStore.createFromPath({
				logicalName: "link.txt",
				path: link,
				mime: "text/plain",
			}),
		).rejects.toThrow("artifact_source_not_regular_file");
		await expect(service.importPaths("conversation-1", [link])).rejects.toMatchObject({
			reason: "attachment_source_type_invalid",
		});
		db.close();
	});
	it("captures generated output trees without accepting symlinks", async () => {
		const { db, root, service } = fixture();
		const output = join(root, "output");
		mkdirSync(join(output, "nested"), { recursive: true });
		writeFileSync(join(output, "nested", "result.txt"), "done");
		const [attachment] = await service.captureOutputs("conversation-1", "run-1", output);
		expect(
			service.semanticRead({
				conversationId: "conversation-1",
				attachmentId: attachment!.id,
			}).files,
		).toContainEqual({
			relativePath: "nested",
			entryKind: "directory",
			readable: false,
		});

		const unsafe = join(root, "unsafe-output");
		mkdirSync(unsafe);
		symlinkSync("../output/nested/result.txt", join(unsafe, "link"));
		await expect(service.captureOutputs("conversation-1", "run-2", unsafe)).rejects.toMatchObject({
			reason: "output_snapshot_failed",
		});
		db.close();
	});

	it("admits CSV once and extracts beyond preview limits", async () => {
		const { db, root, service } = fixture();
		const source = join(root, "records.csv");
		const rows = Array.from({ length: 250 }, (_, index) => `row${index},${index}`);
		writeFileSync(source, `name,value\n${rows.join("\n")}\n`);

		const [attachment] = await service.importPaths("conversation-1", [source]);
		const result = service.semanticRead({
			conversationId: "conversation-1",
			attachmentId: attachment!.id,
			query: "row249",
		});
		expect(result.hits).toHaveLength(1);
		expect(result.hits?.[0]?.excerpt).toContain("row249");
		db.close();
	});
});
