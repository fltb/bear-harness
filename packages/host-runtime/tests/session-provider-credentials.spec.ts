// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import { type CredentialVault, createHostRuntime, type HostRuntime } from "../src/index.js";
import type { SystemDatabase } from "../src/storage/database.js";

const roots: string[] = [];
const runtimes: HostRuntime[] = [];
const characterRoot = fileURLToPath(new URL("./fixtures/characters", import.meta.url));
const vault: CredentialVault = {
	securityLevel: "os",
	isEncryptionAvailable: () => true,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

describe("trusted session provider credentials", () => {
	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.close();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("seeds an OAuth credential before provider sync without persisting its secret", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-session-provider-"));
		roots.push(dataDir);
		const runtime = createHostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig,
			credentialVault: vault,
			sessionProviderCredentials: [
				{
					providerId: "openai-codex",
					credential: {
						type: "oauth",
						access: "access-secret",
						refresh: "refresh-secret",
						expires: Date.now() + 60_000,
						accountId: "account-1",
					},
				},
			],
		});
		runtimes.push(runtime);
		await runtime.start();

		const storage = Reflect.get(runtime, "storage") as { system: SystemDatabase };
		const row = storage.system.connection
			.prepare(
				"SELECT credential_blob, credential_status FROM provider_accounts WHERE provider_id = ?",
			)
			.get("openai-codex") as { credential_blob: Buffer | null; credential_status: string };
		expect(row).toEqual({ credential_blob: null, credential_status: "session_only" });
		const providers = await runtime.dispatch("provider.list", {});
		expect(providers.ok).toBe(true);
		expect(JSON.stringify(providers)).not.toContain("access-secret");
		expect(JSON.stringify(providers)).not.toContain("refresh-secret");
	});
});
