// @vitest-environment node

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import { type CredentialVault, createHostRuntime } from "../src/index.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const roots: string[] = [];
const vault: CredentialVault = {
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

function packageFiles(root: string, directory = root): Array<{ path: string; base64: string }> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? packageFiles(root, path)
			: [
					{
						path: `package/${relative(root, path)}`,
						base64: readFileSync(path).toString("base64"),
					},
				];
	});
}

describe("character package import", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("installs a validated folder into user data and keeps it after restart", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-character-import-"));
		roots.push(dataDir);
		const files = packageFiles(join(characterRoot, "jizhou"));
		const manifest = files.find((file) => file.path.endsWith("/character.yaml"));
		if (!manifest) throw new Error("test character manifest missing");
		manifest.base64 = Buffer.from(
			Buffer.from(manifest.base64, "base64")
				.toString("utf8")
				.replace("id: jizhou", "id: imported-role"),
		).toString("base64");
		const runtime = createHostRuntime({
			dataDir,
			characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		await expect(runtime.dispatch("character.import:v1", { files })).resolves.toMatchObject({
			ok: true,
			data: { character: { id: "imported-role" } },
		});
		await expect(runtime.dispatch("character.activate:v1", { characterId: "imported-role" })).resolves.toMatchObject({
			ok: true,
			data: { character: { id: "imported-role" } },
		});
		const conversation = await runtime.dispatch("conversation.create:v1", {
			title: "Imported role lifecycle",
		});
		if (!conversation.ok) throw new Error(conversation.error.reason);
		await expect(
			runtime.dispatch("roleplay.trigger:v1", {
				conversationId: conversation.data.id,
				eventId: "first_meeting_remembered",
				dedupeKey: "imported-role:remembered",
			}),
		).resolves.toMatchObject({ ok: true, data: { state: { values: { trust: 1 } } } });
		await runtime.close();

		const restarted = createHostRuntime({
			dataDir,
			characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await restarted.start();
		await expect(restarted.dispatch("character.list:v1", {})).resolves.toMatchObject({
			ok: true,
			data: {
				characters: expect.arrayContaining([expect.objectContaining({ id: "imported-role" })]),
			},
		});
		await expect(restarted.dispatch("character.get:v1", {})).resolves.toMatchObject({
			ok: true,
			data: { character: { id: "imported-role" } },
		});
		await expect(
			restarted.dispatch("roleplay.get:v1", { conversationId: conversation.data.id }),
		).resolves.toMatchObject({ ok: true, data: { state: { values: { trust: 1 } } } });
		await restarted.close();
	});

	it("rejects folders without a manifest and traversal paths", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-character-import-invalid-"));
		roots.push(dataDir);
		const runtime = createHostRuntime({
			dataDir,
			characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		await expect(
			runtime.dispatch("character.import:v1", {
				files: [{ path: "package/readme.txt", base64: Buffer.from("hello").toString("base64") }],
			}),
		).resolves.toMatchObject({ ok: false, error: { reason: "character_manifest_missing" } });
		await expect(
			runtime.dispatch("character.import:v1", {
				files: [{ path: "../character.yaml", base64: Buffer.from("id: bad").toString("base64") }],
			}),
		).resolves.toMatchObject({ ok: false, error: { reason: "character_package_path_invalid" } });
		await runtime.close();
	});
});
