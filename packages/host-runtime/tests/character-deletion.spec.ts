// @vitest-environment node

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CredentialVault, createHostRuntime, type HostRuntime } from "../src/index.js";
import type { CompanionStorageRegistry } from "../src/storage/companion-storage.js";

const characterRoot = fileURLToPath(new URL("./fixtures/characters", import.meta.url));
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
	const response = await runtime.dispatch("character.import", {
		files: packageFiles(join(characterRoot, "jizhou"), characterId),
	});
	if (!response.ok) throw new Error(`${response.error.kind}: ${response.error.reason}`);
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("physical character deletion", () => {
	it("finishes character-local orphan maintenance before admitting its first operation", async () => {
		const runtime = createHostRuntime({
			dataDir: root(),
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		try {
			await runtime.start();
			const cas = storage(runtime).layout.companion("jizhou").artifacts;
			mkdirSync(cas, { recursive: true });
			const stale = join(cas, "a".repeat(64));
			const recent = join(cas, "b".repeat(64));
			const unknown = join(cas, "keep-me.txt");
			for (const path of [stale, recent, unknown]) writeFileSync(path, "orphan candidate");
			const old = new Date(Date.now() - 8 * 86_400_000);
			utimesSync(stale, old, old);
			utimesSync(unknown, old, old);
			await runtime.useCharacter("jizhou", () => {
				expect(existsSync(stale)).toBe(false);
				expect(existsSync(recent)).toBe(true);
				expect(existsSync(unknown)).toBe(true);
			});
		} finally {
			await runtime.close();
		}
	});

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
		await runtime.useCharacter("deletable-role", () => {});
		const handle = registry.peek("deletable-role")!;
		const runtimePath = registry.layout.companion("deletable-role").root;
		const packagePath = registry.layout.characterPackage("deletable-role");
		expect(existsSync(runtimePath)).toBe(true);
		expect(existsSync(packagePath)).toBe(true);
		expect(
			await runtime.dispatch("character.deletionStatusGet", {
				characterId: "deletable-role",
			}),
		).toMatchObject({
			ok: true,
			data: {
				status: {
					characterId: "deletable-role",
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

		const closeDatabase = vi.spyOn(handle.database, "close");
		expect(
			await runtime.dispatch("character.runtimeDelete", { characterId: "deletable-role" }),
		).toMatchObject({
			ok: true,
			data: { characterId: "deletable-role", target: "runtime", deleted: true },
		});
		expect(closeDatabase).toHaveBeenCalledOnce();
		expect(existsSync(runtimePath)).toBe(false);
		expect(existsSync(packagePath)).toBe(true);
		expect(await runtime.deleteCharacterRuntime("deletable-role")).toEqual({ deleted: false });

		expect(
			await runtime.dispatch("character.packageDelete", { characterId: "deletable-role" }),
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

	it("deletes any explicitly identified open runtime while retaining unrelated owners and the default package", async () => {
		const dataDir = root();
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		await runtime.start();
		try {
			await importCharacter(runtime, "open-role");
			const first = await runtime.useCharacter(productConfig.defaultCharacterId, (r) => r);
			const other = await runtime.useCharacter("open-role", (r) => r);
			const stopFirst = vi.spyOn(first, "stop");
			const closeOther = vi.spyOn(other, "close");
			expect(await runtime.deleteCharacterRuntime("open-role")).toEqual({ deleted: true });
			expect(closeOther).toHaveBeenCalledOnce();
			expect(stopFirst).not.toHaveBeenCalled();
			expect(await runtime.useCharacter(productConfig.defaultCharacterId, (r) => r)).toBe(first);
			expect(await runtime.deleteCharacterRuntime(productConfig.defaultCharacterId)).toEqual({
				deleted: true,
			});
			expect(
				thrown(() => runtime.deleteCharacterPackage(productConfig.defaultCharacterId)),
			).toMatchObject({ reason: "character_package_default" });
		} finally {
			await runtime.close();
		}
	}, 20_000);

	it("preserves an unopened runtime whose executor ownership is still unresolved", async () => {
		const dataDir = root();
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
		});
		const registry = storage(runtime);
		const characterId = productConfig.defaultCharacterId;
		const handle = registry.open(characterId);
		handle.database.connection
			.prepare("INSERT INTO conversations(id, companion_id) VALUES(?, ?)")
			.run("unknown-session", characterId);
		handle.database.connection.exec(`
			INSERT INTO runs(id, conversation_id, trigger_entry_id, executor_profile, title, instruction, status)
			VALUES('unknown-run', 'unknown-session', 'entry', 'pi-default', 'Unknown controller', 'Work', 'running');
		`);
		registry.release(handle);
		await expect(runtime.deleteCharacterRuntime(characterId)).rejects.toMatchObject({
			kind: "conflict",
			reason: "external_agent_controller_unavailable",
		});
		expect(existsSync(registry.layout.companion(characterId).database)).toBe(true);
		expect(registry.peek(characterId)).toBeUndefined();
		await runtime.close();
		expect(existsSync(registry.layout.companion(characterId).root)).toBe(true);
	});

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
		await expect(runtime.deleteCharacterRuntime("../outside")).rejects.toThrow(
			/safe path component/,
		);
		expect(readFileSync(outside, "utf8")).toBe("keep");

		const registry = storage(runtime);
		const linkedRuntime = registry.layout.companion("linked-role").root;
		symlinkSync(dataDir, linkedRuntime, "dir");
		await expect(runtime.deleteCharacterRuntime("linked-role")).rejects.toThrow(
			/must be a real directory/,
		);
		expect(lstatSync(linkedRuntime).isSymbolicLink()).toBe(true);
		expect(readFileSync(outside, "utf8")).toBe("keep");

		await importCharacter(runtime, "linked-package");
		await runtime.deleteCharacterRuntime("linked-package");
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
