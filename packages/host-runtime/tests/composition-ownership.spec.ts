// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnPipeline } from "../src/companion/turn-pipeline.js";
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
		characterSeedRoot: characterRoot,
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
		characterSeedRoot: characterRoot,
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

	it("resolves uploaded image attachment bytes for Pi while leaving non-images as references", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		const upload = async (name: string, mime: string, buffer: Buffer): Promise<string> => {
			const started = (await data(runtime, "conversationAttachment.startUpload:v1", {
				conversationId: conversation.id,
				kind: "file",
				name,
				entries: [
					{
						entryKind: "file",
						relativePath: name,
						mime,
						bytes: buffer.byteLength,
					},
				],
			})) as { uploadId: string };
			await data(runtime, "conversationAttachment.appendChunk:v1", {
				conversationId: conversation.id,
				uploadId: started.uploadId,
				fileIndex: 0,
				offset: 0,
				base64: buffer.toString("base64"),
			});
			const completed = (await data(runtime, "conversationAttachment.completeUpload:v1", {
				conversationId: conversation.id,
				uploadId: started.uploadId,
			})) as { attachment: { id: string } };
			return completed.attachment.id;
		};
		const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		const imageId = await upload("pixel.png", "image/png", imageBytes);
		const textId = await upload("notes.txt", "text/plain", Buffer.from("reference only"));
		// HostRuntime intentionally keeps composition private; this test observes the in-process handler seam.
		const runtimeInternals = runtime as unknown as { composition: { turns: TurnPipeline } };
		const send = vi.spyOn(runtimeInternals.composition.turns, "sendUserMessage").mockResolvedValue({
			accepted: true,
			sessionId: "session-1",
			entryId: "entry-1",
		});

		await expect(
			runtime.dispatch("message.send:v1", {
				conversationId: conversation.id,
				text: "describe the image",
				attachmentIds: [imageId, textId],
			}),
		).resolves.toMatchObject({
			ok: true,
			data: { accepted: true, sessionId: "session-1", entryId: "entry-1" },
		});
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]?.[0]).toBe(conversation.id);
		expect(send.mock.calls[0]?.[1]).toContain("describe the image");
		expect(send.mock.calls[0]?.[1]).toContain(`${imageId}: pixel.png`);
		expect(send.mock.calls[0]?.[1]).toContain(`${textId}: notes.txt`);
		expect(send.mock.calls[0]?.[2]).toEqual([
			{ attachmentId: imageId, data: imageBytes, mimeType: "image/png" },
		]);
	});

	it("dismisses the previous inline presentation only after the next message is durably accepted", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		const runtimeInternals = runtime as unknown as {
			composition: {
				turns: TurnPipeline;
				eventBus: { publish: (kind: string, payload: unknown) => void };
			};
		};
		runtimeInternals.composition.eventBus.publish("roleplay.media_presented", {
			conversationId: conversation.id,
			mediaId: "continuity_light",
		});
		vi.spyOn(runtimeInternals.composition.turns, "sendUserMessage").mockImplementation(
			async (_conversationId, _text, _images, options) => {
				options.onAccepted?.("pending-turn-1");
				return { accepted: true, sessionId: "session-1", entryId: "entry-1" };
			},
		);

		await data(runtime, "message.send:v1", {
			conversationId: conversation.id,
			text: "continue",
		});

		const snapshot = (await data(runtime, "snapshot.get:v1", {})) as {
			presentation?: { mediaId?: string };
		};
		expect(snapshot.presentation?.mediaId).toBeUndefined();
		const response = (await data(runtime, "events.subscribe:v1", { afterSeq: 0 })) as {
			events: Array<{ kind: string; payload: unknown }>;
		};
		expect(response.events).toContainEqual(
			expect.objectContaining({
				kind: "roleplay.media_dismissed",
				payload: { conversationId: conversation.id, mediaId: "continuity_light" },
			}),
		);
	});

	it("rejects run and attachment operations for unknown ownership", async () => {
		const runtime = makeRuntime();
		await runtime.start();

		await expect(
			runtime.dispatch("run.cancel:v1", { runId: "missing-run" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("run.steer:v1", { runId: "missing-run", instruction: "stop" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
		await expect(
			runtime.dispatch("conversationAttachment.read:v1", {
				mode: "semantic",
				conversationId: "missing-conversation",
				attachmentId: "missing-attachment",
			}),
		).resolves.toMatchObject({ ok: false, error: { kind: "not_found" } });
	});
});
