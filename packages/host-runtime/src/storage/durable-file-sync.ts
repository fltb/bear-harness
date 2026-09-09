import { closeSync, fsyncSync, openSync } from "node:fs";

export interface DurableFileSyncOperations {
	platform: NodeJS.Platform;
	open(path: string, flags: "r" | "r+"): number;
	sync(descriptor: number): void;
	close(descriptor: number): void;
}

const DEFAULT_OPERATIONS: DurableFileSyncOperations = {
	platform: process.platform,
	open: openSync,
	sync: fsyncSync,
	close: closeSync,
};

/** Flush an owned regular file using a Windows-compatible file handle. */
export function syncFileForDurability(
	path: string,
	operations: DurableFileSyncOperations = DEFAULT_OPERATIONS,
): void {
	const descriptor = operations.open(path, operations.platform === "win32" ? "r+" : "r");
	try {
		operations.sync(descriptor);
	} finally {
		operations.close(descriptor);
	}
}
