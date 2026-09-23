import type { Stats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ArtifactStore } from "./index.js";

export interface ArtifactCaptureLimits {
	maxFileBytes: number;
	maxTotalBytes: number;
	maxFiles: number;
	maxEntries: number;
	maxDepth: number;
}

/** Large media and archives remain supported; untrusted outputs have finite work/storage budgets. */
export const DEFAULT_ARTIFACT_CAPTURE_LIMITS: Readonly<ArtifactCaptureLimits> = Object.freeze({
	maxFileBytes: 8 * 1024 ** 3,
	maxTotalBytes: 32 * 1024 ** 3,
	maxFiles: 10_000,
	maxEntries: 50_000,
	maxDepth: 128,
});

export async function captureArtifacts(
	store: ArtifactStore,
	runId: string,
	outputDirectory: string,
	expectedRoot: string,
	limits: Readonly<ArtifactCaptureLimits>,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const initialRoot = await lstat(outputDirectory);
	if (initialRoot.isSymbolicLink() || !initialRoot.isDirectory()) {
		throw new Error("run_output_root_invalid");
	}
	const root = await realpath(outputDirectory);
	if (root !== expectedRoot) throw new Error("run_output_root_changed");
	const rootStat = await lstat(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error("run_output_root_invalid");
	}
	const pending = [{ path: root, depth: 0 }];
	const files: Array<{ path: string; logicalName: string; stat: Stats }> = [];
	let totalBytes = 0;
	let entries = 0;
	while (pending.length) {
		signal.throwIfAborted();
		const directory = pending.pop();
		if (!directory) break;
		const directoryStat = await lstat(directory.path);
		if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
			throw new Error("run_output_directory_invalid");
		}
		if (!within(root, await realpath(directory.path))) throw new Error("run_output_escape");
		for await (const entry of await opendir(directory.path)) {
			signal.throwIfAborted();
			if (++entries > limits.maxEntries) throw new Error("run_output_entry_limit");
			const path = join(directory.path, entry.name);
			const stat = await lstat(path);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				if (directory.depth >= limits.maxDepth) throw new Error("run_output_depth_limit");
				pending.push({ path, depth: directory.depth + 1 });
				continue;
			}
			if (!stat.isFile()) throw new Error("run_output_entry_invalid");
			const canonical = await realpath(path);
			if (!within(root, canonical)) throw new Error("run_output_escape");
			if (stat.size > limits.maxFileBytes) throw new Error("run_output_file_too_large");
			if (files.length >= limits.maxFiles) throw new Error("run_output_file_limit");
			totalBytes += stat.size;
			if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
				throw new Error("run_output_total_too_large");
			}
			files.push({
				path: canonical,
				logicalName: relative(root, canonical).replaceAll("\\", "/"),
				stat,
			});
		}
	}
	for (const file of files.sort((a, b) => a.logicalName.localeCompare(b.logicalName))) {
		signal.throwIfAborted();
		const current = await lstat(file.path);
		if (!sameFile(current, file.stat)) throw new Error("run_output_changed_before_capture");
		const artifact = await store.createFromPath({
			logicalName: file.logicalName,
			path: file.path,
			mime: "application/octet-stream",
			sniffMime: (header) => outputMime(file.path, header),
			producerRunId: runId,
			maxBytes: Math.min(limits.maxFileBytes, file.stat.size),
			signal,
			expectedSource: file.stat,
		});
		await store.markVerifiedAsync(artifact.id, signal);
	}
}

export function outputCaptureFailure(error: unknown): string {
	const reason = error instanceof Error ? error.message : "";
	return /^(run_output_(?:entry_limit|depth_limit|file_limit|file_too_large|total_too_large)|artifact_source_too_large)$/.test(
		reason,
	)
		? reason
		: "output_snapshot_failed";
}

function within(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return (
		child === "" ||
		(!isAbsolute(child) && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\"))
	);
}

function sameFile(left: Stats, right: Stats): boolean {
	return (
		left.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function outputMime(path: string, header: Uint8Array): string {
	const bytes = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "application/pdf";
	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
		return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
		bytes.subarray(0, 6).toString("ascii") === "GIF89a"
	)
		return "image/gif";
	if (
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "image/webp";
	if (
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WAVE"
	)
		return "audio/wav";
	if (
		bytes.subarray(0, 3).toString("ascii") === "ID3" ||
		(bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
	)
		return "audio/mpeg";
	if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
	if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
	const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2] ?? -1);
	return (
		(
			{
				txt: "text/plain",
				md: "text/markdown",
				json: "application/json",
				csv: "text/csv",
				...(zip
					? {
							docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
							xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
							pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
						}
					: {}),
			} as Record<string, string>
		)[extension] ?? "application/octet-stream"
	);
}
