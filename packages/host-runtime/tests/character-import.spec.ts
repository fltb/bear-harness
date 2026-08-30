// @vitest-environment node

import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { type CredentialVault, createHostRuntime } from "../src/index.js";
import {
	DURABLE_FILE_TRANSACTION_VERSION,
	type DurableFileTransactionMarker,
	durableFileTransactionMarkerPath,
} from "../src/storage/durable-file-transaction.js";

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

function persistImportedRecoveryCopy(
	libraryRoot: string,
	characterId: string,
	state: DurableFileTransactionMarker["state"],
): DurableFileTransactionMarker {
	const transactionId =
		characterId === "recovered-before-activation"
			? "30000000-0000-4000-8000-000000000001"
			: "30000000-0000-4000-8000-000000000002";
	const marker: DurableFileTransactionMarker = {
		version: DURABLE_FILE_TRANSACTION_VERSION,
		transactionId,
		target: join(libraryRoot, characterId),
		staging: join(libraryRoot, `.${characterId}.staging-${transactionId}`),
		backup: join(libraryRoot, `.${characterId}.backup-${transactionId}`),
		state,
	};
	const destination = state === "old-target-moved" ? marker.staging : marker.target;
	cpSync(join(characterRoot, "jizhou"), destination, { recursive: true });
	const manifestPath = join(destination, "character.yaml");
	writeFileSync(
		manifestPath,
		readFileSync(manifestPath, "utf8").replace("id: jizhou", `id: ${characterId}`),
	);
	writeFileSync(
		durableFileTransactionMarkerPath(libraryRoot, marker.target),
		`${JSON.stringify(marker)}\n`,
	);
	return marker;
}

describe("character package import", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("edits a local package with revision protection and rejects an immutable id change", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-character-package-edit-"));
		roots.push(dataDir);
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		const initial = await runtime.dispatch("character.packageGet:v1", { characterId: "jizhou" });
		if (!initial.ok) throw new Error(initial.error.reason);
		const yaml = initial.data.package.yaml.replace(
			"极光书房是默认日常位置；当前显示的场景与角色状态中的叙事位置始终优先，不能把默认场景写成不随状态变化的事实。",
			"极昼正在新的值守室等待交接。",
		);
		await expect(
			runtime.dispatch("character.packageUpdate:v1", {
				characterId: "jizhou",
				yaml,
				expectedSha256: initial.data.package.sha256,
			}),
		).resolves.toMatchObject({
			ok: true,
			data: {
				package: {
					character: {
						prompt: { scenario: expect.stringContaining("极昼正在新的值守室等待交接。") },
					},
				},
			},
		});
		await expect(
			runtime.dispatch("character.packageUpdate:v1", {
				characterId: "jizhou",
				yaml,
				expectedSha256: initial.data.package.sha256,
			}),
		).resolves.toMatchObject({ ok: false, error: { kind: "conflict" } });
		const refreshed = await runtime.dispatch("character.packageGet:v1", { characterId: "jizhou" });
		if (!refreshed.ok) throw new Error(refreshed.error.reason);
		await expect(
			runtime.dispatch("character.packageUpdate:v1", {
				characterId: "jizhou",
				yaml: yaml.replace("id: jizhou", "id: another-role"),
				expectedSha256: refreshed.data.package.sha256,
			}),
		).resolves.toMatchObject({ ok: false, error: { reason: "character_id_immutable" } });
		await runtime.close();
	}, 15_000);

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
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		await expect(runtime.dispatch("character.import:v1", { files })).resolves.toMatchObject({
			ok: true,
			data: { character: { id: "imported-role" } },
		});
		await expect(
			runtime.dispatch("character.activate:v1", { characterId: "imported-role" }),
		).resolves.toMatchObject({
			ok: true,
			data: { character: { id: "imported-role" } },
		});
		await expect(runtime.dispatch("canon.listModules:v1", {})).resolves.toMatchObject({
			ok: true,
			data: {
				modules: expect.arrayContaining([
					expect.objectContaining({ stableKey: "station_identity", origin: "package" }),
				]),
			},
		});
		await runtime.close();
		const importedLoader = new CharacterLoader(characterRoot, join(dataDir, "characters"));
		const importedCharacter = importedLoader.load("imported-role");
		if (!importedCharacter) throw new Error("imported character disappeared before restart");

		const restarted = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
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
		await restarted.close();
		const recoveredCharacter = new CharacterLoader(characterRoot, join(dataDir, "characters")).load(
			"imported-role",
		);
		if (!recoveredCharacter) throw new Error("imported character disappeared after restart");
		expect(recoveredCharacter.state.properties.relationship).toBeDefined();
	}, 15_000);

	it("requires explicit trust for imported executable plugins and revokes it when they change", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-character-plugin-trust-"));
		roots.push(dataDir);
		const files = packageFiles(join(characterRoot, "jizhou"));
		files.push({
			path: "package/plugins/test-plugin.mjs",
			base64: Buffer.from(
				"export default function testPlugin(api) { api.registerTool({ name: 'test_plugin' }); }\n",
			).toString("base64"),
		});
		const manifest = files.find((file) => file.path.endsWith("/character.yaml"));
		if (!manifest) throw new Error("test character manifest missing");
		manifest.base64 = Buffer.from(
			Buffer.from(manifest.base64, "base64")
				.toString("utf8")
				.replace("id: jizhou", "id: plugin-trust-role"),
		).toString("base64");
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		await expect(runtime.dispatch("character.import:v1", { files })).resolves.toMatchObject({
			ok: true,
			data: { character: { id: "plugin-trust-role" } },
		});
		await expect(
			runtime.dispatch("character.pluginTrustGet:v1", { characterId: "plugin-trust-role" }),
		).resolves.toMatchObject({
			ok: true,
			data: { trust: { origin: "imported", pluginsPresent: true, trusted: false } },
		});
		await expect(
			runtime.dispatch("character.pluginTrustConfirm:v1", { characterId: "plugin-trust-role" }),
		).resolves.toMatchObject({ ok: true, data: { trust: { trusted: true } } });

		appendFileSync(
			join(dataDir, "characters", "plugin-trust-role", "plugins", "test-plugin.mjs"),
			"\n// package update\n",
		);
		await expect(
			runtime.dispatch("character.pluginTrustGet:v1", { characterId: "plugin-trust-role" }),
		).resolves.toMatchObject({ ok: true, data: { trust: { trusted: false } } });
		await runtime.close();
	});

	it("rejects folders without a manifest and traversal paths", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-character-import-invalid-"));
		roots.push(dataDir);
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
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
	it("recovers imported packages interrupted before and after activation on restart", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-character-import-recovery-"));
		roots.push(dataDir);
		const initial = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await initial.start();
		await initial.close();
		const libraryRoot = join(dataDir, "characters");
		const markers = [
			persistImportedRecoveryCopy(libraryRoot, "recovered-before-activation", "old-target-moved"),
			persistImportedRecoveryCopy(libraryRoot, "recovered-after-activation", "activated"),
		];

		const restarted = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await restarted.start();
		await expect(restarted.dispatch("character.list:v1", {})).resolves.toMatchObject({
			ok: true,
			data: {
				characters: expect.arrayContaining([
					expect.objectContaining({ id: "recovered-before-activation" }),
					expect.objectContaining({ id: "recovered-after-activation" }),
				]),
			},
		});
		for (const marker of markers) {
			expect(existsSync(marker.target)).toBe(true);
			expect(existsSync(marker.staging)).toBe(false);
			expect(existsSync(marker.backup)).toBe(false);
			expect(existsSync(durableFileTransactionMarkerPath(libraryRoot, marker.target))).toBe(false);
		}
		await restarted.close();
	});
});
