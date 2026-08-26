// @vitest-environment node

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DURABLE_FILE_TRANSACTION_VERSION,
	type DurableFileTransactionMarker,
	durableFileTransactionMarkerPath,
	recoverDurableFileTransaction,
	replaceDurableFile,
} from "../src/storage/durable-file-transaction.js";

const roots: string[] = [];
const transactionId = "10000000-0000-4000-8000-000000000001";

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; target: string } {
	const root = mkdtempSync(join(tmpdir(), "bear-durable-file-"));
	roots.push(root);
	return { root, target: join(root, "payload") };
}

function markerFor(
	root: string,
	target: string,
	state: DurableFileTransactionMarker["state"],
): DurableFileTransactionMarker {
	const parent = dirname(target);
	const base = basename(target);
	return {
		version: DURABLE_FILE_TRANSACTION_VERSION,
		transactionId,
		target,
		staging: join(parent, `.${base}.staging-${transactionId}`),
		backup: join(parent, `.${base}.backup-${transactionId}`),
		state,
	};
}

function persistMarker(root: string, marker: DurableFileTransactionMarker): void {
	writeFileSync(durableFileTransactionMarkerPath(root, marker.target), JSON.stringify(marker));
}

function validText(path: string): boolean {
	return readFileSync(path, "utf8").startsWith("valid:");
}

describe("durable file transaction", () => {
	it("creates and verifies a new target, then removes transaction artifacts", async () => {
		const { root, target } = fixture();
		await replaceDurableFile({
			root,
			target,
			stage: (staging) => writeFileSync(staging, "valid:new"),
			verify: validText,
		});

		expect(readFileSync(target, "utf8")).toBe("valid:new");
		expect(existsSync(durableFileTransactionMarkerPath(root, target))).toBe(false);
		expect(existsSync(markerFor(root, target, "activated").backup)).toBe(false);
	});

	it("durably replaces a directory tree", async () => {
		const { root, target } = fixture();
		mkdirSync(target);
		writeFileSync(join(target, "value.txt"), "old");

		await replaceDurableFile({
			root,
			target,
			stage: (staging) => {
				mkdirSync(join(staging, "nested"), { recursive: true });
				writeFileSync(join(staging, "nested", "value.txt"), "new");
			},
			verify: (candidate) => readFileSync(join(candidate, "nested", "value.txt"), "utf8") === "new",
		});

		expect(readFileSync(join(target, "nested", "value.txt"), "utf8")).toBe("new");
		expect(existsSync(join(target, "value.txt"))).toBe(false);
	});

	it("rolls back to the old target when the verifier rejects activation", async () => {
		const { root, target } = fixture();
		writeFileSync(target, "valid:old");

		await expect(
			replaceDurableFile({
				root,
				target,
				stage: (staging) => writeFileSync(staging, "invalid:new"),
				verify: validText,
			}),
		).rejects.toMatchObject({ code: "verification-failed" });
		expect(readFileSync(target, "utf8")).toBe("valid:old");
		expect(existsSync(durableFileTransactionMarkerPath(root, target))).toBe(false);
	});

	it("completes activation after a crash following the old-target move", async () => {
		const { root, target } = fixture();
		const marker = markerFor(root, target, "old-target-moved");
		writeFileSync(marker.staging, "valid:new");
		writeFileSync(marker.backup, "valid:old");
		persistMarker(root, marker);

		const result = await recoverDurableFileTransaction({ root, target, verify: validText });

		expect(result).toMatchObject({ status: "recovered", action: "activated-staging" });
		expect(readFileSync(target, "utf8")).toBe("valid:new");
		expect(existsSync(marker.backup)).toBe(false);
		expect(existsSync(durableFileTransactionMarkerPath(root, target))).toBe(false);
	});

	it("finishes cleanup after a crash following activation", async () => {
		const { root, target } = fixture();
		const marker = markerFor(root, target, "activated");
		writeFileSync(target, "valid:new");
		writeFileSync(marker.backup, "valid:old");
		persistMarker(root, marker);

		const result = await recoverDurableFileTransaction({ root, target, verify: validText });

		expect(result).toMatchObject({ status: "recovered", action: "completed-activation" });
		expect(readFileSync(target, "utf8")).toBe("valid:new");
		expect(existsSync(marker.backup)).toBe(false);
		expect(existsSync(durableFileTransactionMarkerPath(root, target))).toBe(false);
	});

	it("reports an ambiguous layout without changing any copy", async () => {
		const { root, target } = fixture();
		const marker = markerFor(root, target, "old-target-moved");
		writeFileSync(target, "valid:target");
		writeFileSync(marker.staging, "valid:staging");
		writeFileSync(marker.backup, "valid:backup");
		persistMarker(root, marker);

		const result = await recoverDurableFileTransaction({ root, target, verify: validText });

		expect(result).toEqual({
			status: "recovery-required",
			transactionId,
			reason: "ambiguous or invalid transaction layout",
			copies: { target: "valid", staging: "valid", backup: "valid" },
		});
		expect(readFileSync(target, "utf8")).toBe("valid:target");
		expect(readFileSync(marker.staging, "utf8")).toBe("valid:staging");
		expect(readFileSync(marker.backup, "utf8")).toBe("valid:backup");
	});

	it("reports an invalid marker and preserves the valid target", async () => {
		const { root, target } = fixture();
		writeFileSync(target, "valid:only-copy");
		const markerPath = durableFileTransactionMarkerPath(root, target);
		writeFileSync(markerPath, JSON.stringify({ version: 99, target }));

		const result = await recoverDurableFileTransaction({ root, target, verify: validText });

		expect(result).toMatchObject({ status: "recovery-required" });
		expect(readFileSync(target, "utf8")).toBe("valid:only-copy");
		expect(existsSync(markerPath)).toBe(true);
	});

	it("rejects traversal and symlink transaction roots", async () => {
		const { root } = fixture();
		await expect(
			replaceDurableFile({
				root,
				target: join(root, "..", "escaped"),
				stage: (staging) => writeFileSync(staging, "valid:new"),
				verify: validText,
			}),
		).rejects.toMatchObject({ code: "path-outside-root" });

		const linkedRoot = `${root}-link`;
		symlinkSync(root, linkedRoot, "dir");
		roots.push(linkedRoot);
		await expect(
			replaceDurableFile({
				root: linkedRoot,
				target: join(linkedRoot, "target"),
				stage: (staging) => writeFileSync(staging, "valid:new"),
				verify: validText,
			}),
		).rejects.toMatchObject({ code: "symlink-root" });
	});

	it("does not delete the sole valid copy in an invalid recovery layout", async () => {
		const { root, target } = fixture();
		const marker = markerFor(root, target, "old-target-moved");
		writeFileSync(marker.staging, "invalid:partial");
		writeFileSync(marker.backup, "valid:only-copy");
		persistMarker(root, marker);

		const result = await recoverDurableFileTransaction({ root, target, verify: validText });

		expect(result).toMatchObject({
			status: "recovered",
			action: "restored-backup",
		});
		expect(readFileSync(target, "utf8")).toBe("valid:only-copy");
		expect(existsSync(marker.staging)).toBe(false);
		expect(existsSync(durableFileTransactionMarkerPath(root, target))).toBe(false);
	});
});
