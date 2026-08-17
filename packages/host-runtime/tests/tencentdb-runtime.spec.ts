// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bear-harness/tdai-core";
import type { ModelRegistry } from "../src/models/registry.js";
import type { MemoryBackend, MemoryBankScope } from "../src/memory/backend.js";
import { TencentDbRuntime } from "../src/memory/tencentdb-runtime.js";
import type { ProviderCatalog } from "../src/providers/catalog.js";
import { afterEach, describe, expect, it } from "vitest";

const logger: Logger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

const fakeModel = {
	id: "fake-memory-model",
	provider: "fake-memory-provider",
	api: "openai-completions",
	name: "Fake memory model",
};

const fakeModels = {
	getModel(providerId: string, modelId: string) {
		return providerId === fakeModel.provider && modelId === fakeModel.id ? fakeModel : undefined;
	},
	getAvailable(providerId: string) {
		return Promise.resolve(providerId === fakeModel.provider ? [fakeModel] : []);
	},
	completeSimple: async () => ({
		role: "assistant",
		content: [{ type: "text", text: "fake provider response" }],
	}),
};

const fakeProviders = {
	getModels: async () => fakeModels,
} as unknown as ProviderCatalog;

const fakeModelRegistry = {
	defaults: () => ({
		reply: {
			providerId: fakeModel.provider,
			modelId: fakeModel.id,
		},
		vision: { mode: "auto" },
	}),
} as unknown as ModelRegistry;

const provenance = {
	kind: "explicit" as const,
	piSessionEntryIds: ["pi-session-entry-1"] as const,
	sourceRef: "pi-session-1",
};

const scopeFor = (companionId: string): MemoryBankScope => ({
	installationId: "test-installation",
	userId: "test-user",
	companionId,
});

const runtimes: TencentDbRuntime[] = [];
const roots: string[] = [];

function createRuntime(root: string, companionId = "role-a"): TencentDbRuntime {
	const runtime = new TencentDbRuntime({
		dataDir: root,
		providers: fakeProviders,
		models: fakeModelRegistry,
		companionId,
		installationId: "test-installation",
		userId: "test-user",
		logger,
	});
	runtimes.push(runtime);
	return runtime;
}

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "bear-tencentdb-runtime-"));
	roots.push(root);
	return root;
}

async function remember(backend: MemoryBackend, scope: MemoryBankScope, text: string) {
	await backend.open({ scope });
	return backend.remember({ scope, text, provenance, importance: 0.7 });
}

type RuntimeStoreForTest = {
	getCapabilities: () => {
		vectorSearch: boolean;
		ftsSearch: boolean;
		nativeHybridSearch: boolean;
		sparseVectors: boolean;
	};
	queryL1Records: (...args: never[]) => unknown;
};

function runtimeStore(runtime: TencentDbRuntime): RuntimeStoreForTest {
	const core = (runtime as unknown as { core: { getVectorStore(): unknown } }).core;
	const store = core.getVectorStore();
	if (!store) throw new Error("TencentDB runtime did not initialize a local store");
	return store as RuntimeStoreForTest;
}

afterEach(async () => {
	for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TencentDbRuntime", () => {
	it("starts and closes an idempotent local lifecycle under the product data directory", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");

		expect((await runtime.backend.diagnostics()).state).toBe("closed");
		await runtime.start();
		await runtime.start();
		await runtime.backend.open({ scope });
		const created = await runtime.backend.remember({
			scope,
			text: "local lifecycle memory",
			provenance,
		});

		expect(existsSync(join(root, "memory", "vectors.db"))).toBe(true);
		expect(created.provenance).toEqual(provenance);

		await runtime.close();
		await runtime.close();
		expect((await runtime.backend.diagnostics()).state).toBe("closed");
		await expect(runtime.start()).rejects.toThrow("runtime is closed");

		const reopened = createRuntime(root);
		await reopened.start();
		await reopened.backend.open({ scope });
		await expect(
			reopened.backend.update({ scope, memoryId: created.id, text: "reopened local memory" }),
		).resolves.toMatchObject({ id: created.id, text: "reopened local memory" });
	});

	it("keeps role namespaces isolated in the local TencentDB store", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		await runtime.start();
		const roleA = scopeFor("role-a");
		const roleB = scopeFor("role-b");

		await remember(runtime.backend, roleA, "alpine role memory");
		await remember(runtime.backend, roleB, "beryl role memory");

		await runtime.backend.open({ scope: roleA });
		const roleAHits = await runtime.backend.recall({ scope: roleA, query: "alpine", limit: 10 });
		await runtime.backend.open({ scope: roleB });
		const roleBHits = await runtime.backend.recall({ scope: roleB, query: "beryl", limit: 10 });

		expect(roleAHits.map((hit) => hit.record.text)).toEqual(["alpine role memory"]);
		expect(roleBHits.map((hit) => hit.record.text)).toEqual(["beryl role memory"]);
		expect(roleAHits.every((hit) => hit.record.scope.companionId === "role-a")).toBe(true);
		expect(roleBHits.every((hit) => hit.record.scope.companionId === "role-b")).toBe(true);
	});

	it("supports direct remember, update, invalidate, and forget mutations", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");
		await runtime.start();

		const created = await remember(runtime.backend, scope, "mutable local memory");
		const updated = await runtime.backend.update({
			scope,
			memoryId: created.id,
			text: "updated local memory",
			importance: 0.95,
			metadata: {
				activity_start_time: "2026-08-17T09:00:00.000Z",
				activity_end_time: "2026-08-17T10:00:00.000Z",
			},
		});
		expect(updated).toMatchObject({
			id: created.id,
			text: "updated local memory",
			importance: 0.95,
			status: "active",
			metadata: {
				activity_start_time: "2026-08-17T09:00:00.000Z",
				activity_end_time: "2026-08-17T10:00:00.000Z",
			},
		});

		const invalidated = await runtime.backend.invalidate({
			scope,
			memoryId: created.id,
			replacementMemoryId: "replacement-memory",
			reason: "superseded by the direct edit",
		});
		expect(invalidated).toMatchObject({ id: created.id, status: "invalidated" });
		expect(invalidated.invalidatedAt).toEqual(expect.any(String));

		await runtime.backend.forget({ scope, memoryId: created.id });
		await expect(runtime.backend.update({ scope, memoryId: created.id, text: "gone" })).rejects.toThrow(
			"TencentDB memory not found",
		);
	});

	it("does not scan stored text when native retrieval capabilities are unavailable", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");
		await runtime.start();
		await remember(runtime.backend, scope, "manual substring fallback sentinel");

		const store = runtimeStore(runtime);
		const availableCapabilities = store.getCapabilities();
		const originalGetCapabilities = store.getCapabilities;
		const originalQueryL1Records = store.queryL1Records;
		store.getCapabilities = () => ({
			...availableCapabilities,
			ftsSearch: false,
			nativeHybridSearch: false,
		});
		store.queryL1Records = () => {
			throw new Error("manual substring fallback must not query all records");
		};

		try {
			await runtime.backend.open({ scope });
			await expect(
				runtime.backend.recall({ scope, query: "substring", limit: 10 }),
			).resolves.toEqual([]);
		} finally {
			store.getCapabilities = originalGetCapabilities;
			store.queryL1Records = originalQueryL1Records;
		}
	});
});
