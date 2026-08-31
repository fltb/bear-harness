// @vitest-environment node

import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CredentialVault, createHostRuntime, type HostRuntime } from "../src/index.js";
import type { CompanionStorageRegistry } from "../src/storage/companion-storage.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const roots: string[] = [];
const vault: CredentialVault = {
	securityLevel: "session",
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "bear-character-deletion-"));
	roots.push(value);
	return value;
}

function packageFiles(
	rootDirectory: string,
	characterId: string,
	directory = rootDirectory,
): Array<{ path: string; base64: string }> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return packageFiles(rootDirectory, characterId, path);
		const content =
			entry.name === "character.yaml"
				? Buffer.from(readFileSync(path, "utf8").replace("id: jizhou", `id: ${characterId}`))
				: readFileSync(path);
		return [
			{
				path: `package/${relative(rootDirectory, path)}`,
				base64: content.toString("base64"),
			},
		];
	});
}

function storage(runtime: HostRuntime): CompanionStorageRegistry {
	return Reflect.get(runtime, "storage") as CompanionStorageRegistry;
}

function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected operation to throw");
}

async function importCharacter(runtime: HostRuntime, characterId: string): Promise<void> {
	const response = await runtime.dispatch("character.import:v1", {
		files: packageFiles(join(characterRoot, "jizhou"), characterId),
	});
	if (!response.ok) throw new Error(`${response.error.kind}: ${response.error.reason}`);
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("physical character deletion", () => {
	it("deletes an inactive runtime independently, closes its database, then deletes its package", async () => {
		const dataDir = root();
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		await importCharacter(runtime, "deletable-role");
		const registry = storage(runtime);
		const runtimePath = registry.layout.companion("deletable-role").root;
		const packagePath = registry.layout.characterPackage("deletable-role");
		expect(existsSync(runtimePath)).toBe(true);
		expect(existsSync(packagePath)).toBe(true);
		expect(
			await runtime.dispatch("character.deletionStatusGet:v1", {
				characterId: "deletable-role",
			}),
		).toMatchObject({
			ok: true,
			data: {
				status: {
					characterId: "deletable-role",
					active: false,
					default: false,
					runtimePresent: true,
					packagePresent: true,
				},
			},
		});
		expect(thrown(() => runtime.deleteCharacterPackage("deletable-role"))).toMatchObject({
			kind: "conflict",
			reason: "character_runtime_exists",
		});

		const handle = registry.open("deletable-role");
		const closeDatabase = vi.spyOn(handle.database, "close");
		expect(
			await runtime.dispatch("character.runtimeDelete:v1", { characterId: "deletable-role" }),
		).toMatchObject({
			ok: true,
			data: { characterId: "deletable-role", target: "runtime", deleted: true },
		});
		expect(closeDatabase).toHaveBeenCalledOnce();
		expect(existsSync(runtimePath)).toBe(false);
		expect(existsSync(packagePath)).toBe(true);
		expect(runtime.deleteCharacterRuntime("deletable-role")).toEqual({ deleted: false });

		expect(
			await runtime.dispatch("character.packageDelete:v1", { characterId: "deletable-role" }),
		).toMatchObject({
			ok: true,
			data: { characterId: "deletable-role", target: "package", deleted: true },
		});
		expect(existsSync(packagePath)).toBe(false);
		expect(existsSync(registry.layout.characterPackage(productConfig.defaultCharacterId))).toBe(
			true,
		);
		expect(
			registry.system.connection
				.prepare("SELECT id FROM companion_identity WHERE id = ?")
				.get("deletable-role"),
		).toBeUndefined();
		expect(
			registry.system.connection
				.prepare("SELECT id FROM companion_packages WHERE id = ?")
				.get("deletable-role"),
		).toBeUndefined();
		expect(runtime.deleteCharacterPackage("deletable-role")).toEqual({ deleted: false });
		await runtime.close();
	}, 20_000);

	it("refuses active runtime, active package, and the default package", async () => {
		const dataDir = root();
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		expect(
			thrown(() => runtime.deleteCharacterRuntime(productConfig.defaultCharacterId)),
		).toMatchObject({ kind: "conflict", reason: "character_runtime_active" });
		expect(
			thrown(() => runtime.deleteCharacterPackage(productConfig.defaultCharacterId)),
		).toMatchObject({ kind: "conflict", reason: "character_package_default" });

		await importCharacter(runtime, "active-role");
		const activated = await runtime.dispatch("character.activate:v1", {
			characterId: "active-role",
		});
		if (!activated.ok) throw new Error(`${activated.error.kind}: ${activated.error.reason}`);
		expect(thrown(() => runtime.deleteCharacterRuntime("active-role"))).toMatchObject({
			kind: "conflict",
			reason: "character_runtime_active",
		});
		expect(thrown(() => runtime.deleteCharacterPackage("active-role"))).toMatchObject({
			kind: "conflict",
			reason: "character_package_active",
		});
		await runtime.close();
	}, 20_000);

	it("rejects unsafe ids and replacement symlinks without touching their targets", async () => {
		const dataDir = root();
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		const outside = join(dataDir, "outside");
		writeFileSync(outside, "keep", "utf8");
		expect(() => runtime.deleteCharacterRuntime("../outside")).toThrow(/safe path component/);
		expect(readFileSync(outside, "utf8")).toBe("keep");

		const registry = storage(runtime);
		const linkedRuntime = registry.layout.companion("linked-role").root;
		symlinkSync(dataDir, linkedRuntime, "dir");
		expect(() => runtime.deleteCharacterRuntime("linked-role")).toThrow(/must be a real directory/);
		expect(lstatSync(linkedRuntime).isSymbolicLink()).toBe(true);
		expect(readFileSync(outside, "utf8")).toBe("keep");

		await importCharacter(runtime, "linked-package");
		runtime.deleteCharacterRuntime("linked-package");
		const packagePath = registry.layout.characterPackage("linked-package");
		const outsidePackage = join(dataDir, "outside-package");
		renameSync(packagePath, outsidePackage);
		symlinkSync(outsidePackage, packagePath, "dir");
		expect(() => runtime.deleteCharacterPackage("linked-package")).toThrow(
			/character package directory must be a real directory/,
		);
		expect(lstatSync(packagePath).isSymbolicLink()).toBe(true);
		expect(existsSync(join(outsidePackage, "character.yaml"))).toBe(true);
		expect(
			registry.system.connection
				.prepare("SELECT id FROM companion_packages WHERE id = ?")
				.get("linked-package"),
		).toEqual({ id: "linked-package" });
		await runtime.close();
	}, 20_000);
});
