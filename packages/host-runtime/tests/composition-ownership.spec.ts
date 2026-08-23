// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import { type CredentialVault, createHostRuntime, type HostRuntime } from "../src/index.js";

const roots: string[] = [];
const runtimes: HostRuntime[] = [];
const silentLogger = { debug: () => undefined, warn: () => undefined };
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const vault: CredentialVault = {
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

function makeRuntime() {
	const dataDir = mkdtempSync(join(tmpdir(), "bear-ownership-"));
	roots.push(dataDir);
	const runtime = createHostRuntime({
		dataDir,
		characterRoot,
		productConfig,
		credentialVault: vault,
		logger: silentLogger,
	});
	runtimes.push(runtime);
	return runtime;
}

function makeRuntimeAt(dataDir: string) {
	const runtime = createHostRuntime({
		dataDir,
		characterRoot,
		productConfig,
		credentialVault: vault,
		logger: silentLogger,
	});
	runtimes.push(runtime);
	return runtime;
}

async function data(runtime: HostRuntime, channel: string, params: unknown): Promise<unknown> {
	const response = await runtime.dispatch(channel, params);
	if (!response.ok) throw new Error(response.error.reason);
	return response.data;
}


describe("Host composition enforces ownership before mutation", () => {
	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.close();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("dismisses only media declared by the active character", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };

		await expect(
			runtime.dispatch("roleplay.dismissMedia:v1", {
				conversationId: conversation.id,
				mediaId: "continuity_light",
			}),
		).resolves.toMatchObject({ ok: true, data: {} });
		await expect(
			runtime.dispatch("roleplay.dismissMedia:v1", {
				conversationId: conversation.id,
				mediaId: "missing_media",
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "not_found", reason: "roleplay_media_not_found" },
		});

		const response = (await data(runtime, "events.subscribe:v1", { afterSeq: 0 })) as {
			events: Array<{ kind: string; payload: unknown }>;
		};
		expect(response.events).toContainEqual(
			expect.objectContaining({
				kind: "roleplay.media_dismissed",
				payload: { conversationId: conversation.id, mediaId: "continuity_light" },
			}),
		);
		expect(response.events).not.toContainEqual(
			expect.objectContaining({
				kind: "roleplay.media_dismissed",
				payload: { conversationId: conversation.id, mediaId: "missing_media" },
			}),
		);
	});

	it("rejects run, commission and artifact operations for unknown IDs", async () => {
		const runtime = makeRuntime();
		await runtime.start();

		await expect(
			runtime.dispatch("run.cancel:v1", { runId: "missing-run" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("run.steer:v1", { runId: "missing-run", instruction: "stop" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("commission.reject:v1", { commissionId: "missing-commission" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("artifact.read:v1", { artifactId: "missing-artifact" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("artifact.url:v1", { artifactId: "missing-artifact" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
	});
});
