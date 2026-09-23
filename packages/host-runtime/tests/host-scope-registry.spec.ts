import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostRuntime, type HostRuntime } from "../src/runtime.js";
import type { AppSettingsStore } from "../src/storage/app-settings-store.js";

const seed = fileURLToPath(new URL("./fixtures/characters", import.meta.url));
const hosts: Array<{ host: HostRuntime; root: string }> = [];
function setup() {
	const root = mkdtempSync(join(tmpdir(), "bear-explicit-scopes-"));
	const host = createHostRuntime({
		dataDir: root,
		characterSeedRoot: seed,
		productConfig,
		credentialVault: {
			securityLevel: "session",
			isEncryptionAvailable: () => false,
			encryptString: (value) => Buffer.from(value),
			decryptString: (value) => value.toString(),
		},
	});
	const other = join(root, "characters", "other");
	cpSync(join(root, "characters", "jizhou"), other, { recursive: true });
	const manifest = join(other, "character.yaml");
	writeFileSync(manifest, readFileSync(manifest, "utf8").replace("id: jizhou", "id: other"));
	hosts.push({ host, root });
	return { host, root };
}
afterEach(async () => {
	for (const { host, root } of hosts.splice(0)) {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	}
});

describe("explicit Host resource scopes", () => {
	it("serves installation queries and rejects missing routes without opening a character", async () => {
		const { host, root } = setup();
		expect(await host.dispatch("bootstrap.get", {})).toEqual({
			ok: true,
			data: { defaultCharacterId: "jizhou" },
		});
		expect(await host.dispatch("settings.get", {})).toMatchObject({ ok: true });
		expect(await host.dispatch("snapshot.get", {})).toMatchObject({
			ok: false,
			error: { kind: "invalid_request" },
		});
		expect(await host.dispatch("conversation.activeGet", {})).toMatchObject({
			ok: false,
			error: { reason: "handler_not_registered" },
		});
		expect(existsSync(join(root, "companions", "jizhou", "runtime.db"))).toBe(false);
		expect(await host.dispatch("snapshot.get", { characterId: "other" })).toMatchObject({
			ok: true,
			data: { character: { id: "other" } },
		});
		expect(existsSync(join(root, "companions", "jizhou", "runtime.db"))).toBe(false);
	});

	it("retains one A database across overlapping A/B/A operations and drains it before deletion", async () => {
		const { host, root } = setup();
		let finish!: () => void;
		let entered!: () => void;
		const begun = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const operation = host.useCharacter("jizhou", async (runtime) => {
			entered();
			await waiting;
			return runtime.db.orm
				.select()
				.from((await import("../src/storage/schema.js")).companionRuntimeIdentity)
				.get();
		});
		await begun;
		const original = await host.useCharacter("jizhou", (r) => r);
		await host.dispatch("snapshot.get", { characterId: "other" });
		expect(await host.useCharacter("jizhou", (r) => r)).toBe(original);
		const close = vi.spyOn(original.db, "close");
		const deletion = host.deleteCharacterRuntime("jizhou");
		expect(existsSync(join(root, "companions", "jizhou"))).toBe(true);
		expect(close).not.toHaveBeenCalled();
		expect(await host.dispatch("snapshot.get", { characterId: "jizhou" })).toMatchObject({
			ok: false,
			error: { reason: "character_runtime_closing" },
		});
		finish();
		expect(await operation).toMatchObject({ companionId: "jizhou" });
		expect(await deletion).toEqual({ deleted: true });
		expect(close).toHaveBeenCalledOnce();
		expect(await host.dispatch("snapshot.get", { characterId: "other" })).toMatchObject({
			ok: true,
			data: { character: { id: "other" } },
		});
	});

	it("requires independent character consent and persists it without sharing it with another character", async () => {
		const { host } = setup();
		const settings = Reflect.get(host, "appSettings") as AppSettingsStore;
		settings.save({
			memoryVectorService: {
				enabled: true,
				provider: "remote",
				baseUrl: "https://example.invalid",
				model: "embedding",
				dimensions: 3,
			},
		});
		expect(await host.dispatch("character.memoryGet", { characterId: "jizhou" })).toEqual({
			ok: true,
			data: { enabled: false },
		});
		expect(
			await host.dispatch("character.memorySet", { characterId: "jizhou", enabled: true }),
		).toEqual({ ok: true, data: { enabled: true } });
		expect(await host.useCharacter("jizhou", (r) => r.relationshipMemoryEnabled)).toBe(true);
		expect(await host.useCharacter("other", (r) => r.relationshipMemoryEnabled)).toBe(false);
		expect(await host.dispatch("character.memoryGet", { characterId: "other" })).toEqual({
			ok: true,
			data: { enabled: false },
		});
		settings.save({ memoryVectorService: { enabled: false, provider: "none" } });
		expect(await host.useCharacter("jizhou", (r) => r.relationshipMemoryEnabled)).toBe(false);
		expect(await host.dispatch("character.memoryGet", { characterId: "jizhou" })).toEqual({
			ok: true,
			data: { enabled: true },
		});
	});
});
