import { randomUUID } from "node:crypto";
import { appendFileSync, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { type Entry, open, type ZipFile } from "yauzl";

/** Ephemeral upload resources. Only opaque ids cross the renderer boundary. */
export class CharacterArchiveImport<T> {
	private readonly uploads = new Map<string, { directory: string; offset: number }>();
	private readonly pending = new Set<Promise<T>>();
	private closed = false;
	constructor(
		private readonly root: string,
		private readonly install: (directory: string) => T,
	) {
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	begin(): { uploadId: string } {
		if (this.closed) throw new Error("character_import_closed");
		const uploadId = randomUUID();
		const directory = join(this.root, uploadId);
		mkdirSync(directory, { mode: 0o700 });
		this.uploads.set(uploadId, { directory, offset: 0 });
		return { uploadId };
	}
	append(uploadId: string, offset: number, base64: string): void {
		const upload = this.uploads.get(uploadId);
		if (!upload || upload.offset !== offset) throw new Error("character_import_upload_invalid");
		const bytes = Buffer.from(base64, "base64");
		appendFileSync(join(upload.directory, "package.zip"), bytes, { mode: 0o600 });
		upload.offset += bytes.length;
	}
	finish(uploadId: string): Promise<T> {
		const upload = this.uploads.get(uploadId);
		if (!upload) return Promise.reject(new Error("character_import_upload_invalid"));
		this.uploads.delete(uploadId);
		const work = (async () => {
			try {
				const destination = join(upload.directory, "extracted");
				mkdirSync(destination, { mode: 0o700 });
				await extractArchive(join(upload.directory, "package.zip"), destination);
				return this.install(destination);
			} finally {
				rmSync(upload.directory, { recursive: true, force: true });
			}
		})();
		this.pending.add(work);
		void work.then(
			() => this.pending.delete(work),
			() => this.pending.delete(work),
		);
		return work;
	}
	cancel(uploadId: string): void {
		const upload = this.uploads.get(uploadId);
		if (!upload) return;
		this.uploads.delete(uploadId);
		rmSync(upload.directory, { recursive: true, force: true });
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const id of this.uploads.keys()) this.cancel(id);
		await Promise.allSettled(this.pending);
		rmSync(this.root, { recursive: true, force: true });
	}
}

async function extractArchive(path: string, destination: string): Promise<void> {
	const zip = await new Promise<ZipFile>((resolve, reject) =>
		open(
			path,
			{ lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
			(error, file) =>
				error
					? reject(error)
					: file
						? resolve(file)
						: reject(new Error("character_archive_invalid")),
		),
	);
	const names = new Set<string>();
	await new Promise<void>((resolve, reject) => {
		const fail = (error: unknown) => {
			zip.close();
			reject(error);
		};
		zip.once("error", fail);
		zip.once("end", resolve);
		zip.on("entry", (entry: Entry) => {
			void (async () => {
				const name = entry.fileName;
				const parts = name.replace(/\/$/, "").split("/");
				const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
				if (
					!name ||
					name.includes("\\") ||
					name.includes(":") ||
					Array.from(name).some((c) => c.charCodeAt(0) < 32) ||
					parts.some((p) => !p || p === "." || p === "..") ||
					names.has(name) ||
					(mode && mode !== 0x8000 && mode !== 0x4000) ||
					entry.isEncrypted()
				)
					throw new Error("character_archive_entry_invalid");
				names.add(name);
				const target = join(destination, ...parts);
				if (name.endsWith("/")) {
					if (entry.uncompressedSize !== 0) throw new Error("character_archive_directory_invalid");
					mkdirSync(target, { recursive: true, mode: 0o700 });
				} else {
					mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
					const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
						zip.openReadStream(entry, (error, stream) =>
							error
								? reject(error)
								: stream
									? resolve(stream)
									: reject(new Error("character_archive_invalid")),
						),
					);
					let checksum = 0;
					const verify = new Transform({
						transform(chunk: Buffer, _encoding, callback) {
							checksum = crc32(chunk, checksum);
							callback(null, chunk);
						},
					});
					await pipeline(stream, verify, createWriteStream(target, { flags: "wx", mode: 0o600 }));
					if (checksum !== entry.crc32) throw new Error("character_archive_crc_invalid");
				}
				zip.readEntry();
			})().catch(fail);
		});
		zip.readEntry();
	});
}
