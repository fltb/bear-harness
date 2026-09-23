import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAX_ARTIFACT_READ_BYTES } from "@bear-harness/protocol/schema";
import type { ArtifactRecord, ArtifactStore } from "./index.js";

export type ArtifactPresentationOutcome = {
	outcome: "completed" | "cancelled" | "unsupported";
};

/** Short-lived access to one ownership- and integrity-validated artifact. */
export interface ArtifactPresentationAccess {
	read(
		offset: number,
		length: number,
	): Promise<{ buffer: Buffer; nextOffset: number; eof: boolean }>;
	withMaterializedFile<T>(use: (path: string) => T | Promise<T>): Promise<T>;
}

export interface ArtifactPresentationRequest {
	artifact: Readonly<ArtifactRecord>;
	access: ArtifactPresentationAccess;
}

/** OS-shell adapter. No path returned by this adapter is exposed on the wire. */
export interface ArtifactPresenter {
	open?(
		request: ArtifactPresentationRequest,
	): ArtifactPresentationOutcome | Promise<ArtifactPresentationOutcome>;
	reveal?(
		request: ArtifactPresentationRequest,
	): ArtifactPresentationOutcome | Promise<ArtifactPresentationOutcome>;
	saveAs?(
		request: ArtifactPresentationRequest,
	): ArtifactPresentationOutcome | Promise<ArtifactPresentationOutcome>;
}

export interface ScopedArtifactPresentationAccess {
	access: ArtifactPresentationAccess;
	close(): Promise<void>;
}

/**
 * Give one presenter invocation bounded reads and private temporary
 * materialization. The capability expires when the invocation completes.
 */
export function createArtifactPresentationAccess(
	store: ArtifactStore,
	record: ArtifactRecord,
): ScopedArtifactPresentationAccess {
	let active = true;
	const operations = new Set<Promise<unknown>>();
	const controller = new AbortController();
	let closing: Promise<void> | undefined;
	let failed: { reason: unknown } | undefined;
	const track = <T>(task: Promise<T>): Promise<T> => {
		operations.add(task);
		void task.then(
			() => operations.delete(task),
			(reason) => {
				operations.delete(task);
				failed ??= { reason };
			},
		);
		return task;
	};
	const assertActive = () => {
		if (!active) throw new Error("artifact_presentation_access_expired");
	};
	const access: ArtifactPresentationAccess = Object.freeze({
		read(offset: number, length: number) {
			assertActive();
			return track(
				store.readBlobRange(record.id, offset, length, controller.signal).then((range) => {
					if (!range) throw { kind: "not_found", reason: "artifact_not_found" };
					return range;
				}),
			);
		},
		withMaterializedFile<T>(use: (path: string) => T | Promise<T>): Promise<T> {
			assertActive();
			return track(materializeArtifact(store, record, use, controller.signal));
		},
	});
	return {
		access,
		close() {
			active = false;
			controller.abort();
			closing ??= (async () => {
				await Promise.allSettled(operations);
				operations.clear();
				if (failed) throw failed.reason;
			})();
			return closing;
		},
	};
}

async function materializeArtifact<T>(
	store: ArtifactStore,
	record: ArtifactRecord,
	use: (path: string) => T | Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "bear-artifact-"));
	const path = join(directory, safeName(record.logicalName));
	let file: FileHandle | undefined;
	try {
		file = await open(path, "wx", 0o600);
		let offset = 0;
		do {
			signal.throwIfAborted();
			const range = await store.readBlobRange(
				record.id,
				offset,
				Math.max(1, Math.min(MAX_ARTIFACT_READ_BYTES, record.bytes - offset)),
				signal,
			);
			if (!range) throw { kind: "not_found", reason: "artifact_not_found" };
			await writeAll(file, range.buffer);
			if (range.nextOffset <= offset && !range.eof)
				throw new Error("artifact_materialization_stalled");
			offset = range.nextOffset;
		} while (offset < record.bytes);
		await file.sync();
		await file.close();
		file = undefined;
		signal.throwIfAborted();
		return await use(path);
	} finally {
		if (file) await file.close().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
}

async function writeAll(file: FileHandle, buffer: Buffer): Promise<void> {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, null);
		if (bytesWritten < 1) throw new Error("artifact_materialization_stalled");
		offset += bytesWritten;
	}
}

function safeName(logicalName: string): string {
	const leaf = [...basename(logicalName)]
		.map((character) => {
			const code = character.charCodeAt(0);
			return character === "/" || character === "\\" || code < 32 || code === 127 ? "_" : character;
		})
		.join("")
		.slice(0, 200);
	return leaf && leaf !== "." && leaf !== ".." ? leaf : "artifact";
}
