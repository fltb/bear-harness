// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import type { HostUpdateService } from "../src/composition.js";
import { createHostRuntime } from "../src/index.js";

const roots: string[] = [];
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const vault = {
	isEncryptionAvailable: () => false,
	encryptString: (value: string) => Buffer.from(value),
	decryptString: (value: Buffer) => value.toString("utf8"),
};

function makeRuntime(updateService?: HostUpdateService) {
	const dataDir = mkdtempSync(join(tmpdir(), "bear-update-ipc-"));
	roots.push(dataDir);
	return createHostRuntime({
		dataDir,
		characterSeedRoot: characterRoot,
		productConfig,
		credentialVault: vault,
		updateService,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Host update IPC handlers", () => {
	it("routes check, discard, and apply through the desktop adapter", async () => {
		const calls: string[] = [];
		const updateService: HostUpdateService = {
			check: async () => {
				calls.push("check");
				return {
					state: "available",
					currentVersion: "1.0.0",
					latestVersion: "2.0.0",
					feedUrl: "https://updates.example/feed.json",
				};
			},
			discard: async () => {
				calls.push("discard");
				return { state: "idle", discarded: true };
			},
			apply: async () => {
				calls.push("apply");
				return {
					state: "ready",
					applyUnsupported: true,
					error: "Update installation requires an external installer",
				};
			},
		};
		const runtime = makeRuntime(updateService);
		try {
			await runtime.start();
			expect(await runtime.dispatch("update.check:v1", {})).toMatchObject({
				ok: true,
				data: { state: "available", currentVersion: "1.0.0", latestVersion: "2.0.0" },
			});
			expect(await runtime.dispatch("update.discard:v1", {})).toMatchObject({
				ok: true,
				data: { state: "idle", discarded: true },
			});
			expect(await runtime.dispatch("update.apply:v1", {})).toMatchObject({
				ok: true,
				data: { state: "ready", applyUnsupported: true },
			});
			expect(calls).toEqual(["check", "discard", "apply"]);
		} finally {
			await runtime.close();
		}
	});

	it("returns disabled responses when no desktop update service is supplied", async () => {
		const runtime = makeRuntime();
		try {
			await runtime.start();
			expect(await runtime.dispatch("update.check:v1", {})).toMatchObject({
				ok: true,
				data: { state: "disabled" },
			});
			expect(await runtime.dispatch("update.discard:v1", {})).toMatchObject({
				ok: true,
				data: { state: "disabled", discarded: false },
			});
			expect(await runtime.dispatch("update.apply:v1", {})).toMatchObject({
				ok: true,
				data: { state: "disabled", applyUnsupported: true },
			});
		} finally {
			await runtime.close();
		}
	});
});
