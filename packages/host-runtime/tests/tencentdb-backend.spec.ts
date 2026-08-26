// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
	type MemoryBankScope,
	type MemoryMetadata,
	withMemoryNotifications,
} from "../src/memory/backend.js";
import {
	legacyNamespaceFor,
	namespaceFor,
	type TencentDbCoreHit,
	type TencentDbCoreNamespaceMigrationRequest,
	type TencentDbCoreRecord,
	TencentDbMemoryBackend,
	type TencentDbMemoryCoreFacade,
} from "../src/memory/tencentdb-backend.js";

const provenance = {
	kind: "explicit" as const,
	piSessionEntryIds: ["pi-entry-1"] as const,
};

const scopeA: MemoryBankScope = {
	installationId: "install-a",
	userId: "user-a",
	companionId: "companion-a",
};

const scopeB: MemoryBankScope = {
	installationId: "install-b",
	userId: "user-a",
	companionId: "companion-a",
};

class FakeTencentDbCore implements TencentDbMemoryCoreFacade {
	readonly calls: Array<{ method: string; request: Record<string, unknown> }> = [];
	private nextId = 1;
	private readonly records = new Map<string, Map<string, TencentDbCoreRecord>>();

	migrateNamespace(request: TencentDbCoreNamespaceMigrationRequest): Promise<void> {
		this.calls.push({ method: "migrateNamespace", request });
		const legacy = this.forNamespace(request.legacyNamespace);
		const canonical = this.forNamespace(request.canonicalNamespace);
		for (const [id, record] of legacy) {
			const existing = canonical.get(id);
			if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
				const error = Object.assign(new Error(`migration conflict for ${id}`), {
					code: "recovery_required",
				});
				return Promise.reject(error);
			}
		}
		for (const [id, record] of legacy) canonical.set(id, { ...record });
		legacy.clear();
		return Promise.resolve();
	}

	remember(
		request: Parameters<TencentDbMemoryCoreFacade["remember"]>[0],
	): Promise<TencentDbCoreRecord> {
		this.calls.push({ method: "remember", request });
		const record: TencentDbCoreRecord = {
			id: `memory-${this.nextId++}`,
			text: request.text,
			provenance: request.provenance,
			importance: request.importance ?? 0.5,
			status: "active",
			metadata: request.metadata ?? {},
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		this.forNamespace(request.namespace).set(record.id, record);
		return Promise.resolve(record);
	}

	recall(
		request: Parameters<TencentDbMemoryCoreFacade["recall"]>[0],
	): Promise<readonly TencentDbCoreHit[]> {
		this.calls.push({ method: "recall", request });
		const records = [...this.forNamespace(request.namespace).values()].filter(
			(record) => record.status === "active" && record.text.includes(request.query),
		);
		return Promise.resolve(records.map((record, index) => ({ record, score: 1 - index / 10 })));
	}

	update(
		request: Parameters<TencentDbMemoryCoreFacade["update"]>[0],
	): Promise<TencentDbCoreRecord> {
		this.calls.push({ method: "update", request });
		const current = this.get(request.namespace, request.memoryId);
		const record = {
			...current,
			text: request.text ?? current.text,
			importance: request.importance ?? current.importance,
			metadata: request.metadata ?? current.metadata,
			updatedAt: "2026-01-01T00:01:00.000Z",
		};
		this.forNamespace(request.namespace).set(record.id, record);
		return Promise.resolve(record);
	}

	forget(request: Parameters<TencentDbMemoryCoreFacade["forget"]>[0]): Promise<void> {
		this.calls.push({ method: "forget", request });
		this.forNamespace(request.namespace).delete(request.memoryId);
		return Promise.resolve();
	}

	invalidate(
		request: Parameters<TencentDbMemoryCoreFacade["invalidate"]>[0],
	): Promise<TencentDbCoreRecord> {
		this.calls.push({ method: "invalidate", request });
		const current = this.get(request.namespace, request.memoryId);
		const record = {
			...current,
			status: "invalidated" as const,
			invalidatedAt: "2026-01-01T00:02:00.000Z",
			updatedAt: "2026-01-01T00:02:00.000Z",
		};
		this.forNamespace(request.namespace).set(record.id, record);
		return Promise.resolve(record);
	}

	setImportance(
		request: Parameters<TencentDbMemoryCoreFacade["setImportance"]>[0],
	): Promise<TencentDbCoreRecord> {
		this.calls.push({ method: "setImportance", request });
		const current = this.get(request.namespace, request.memoryId);
		const record = { ...current, importance: request.importance };
		this.forNamespace(request.namespace).set(record.id, record);
		return Promise.resolve(record);
	}

	list(request: { namespace: string; limit?: number }): Promise<readonly TencentDbCoreRecord[]> {
		return Promise.resolve(
			[...this.forNamespace(request.namespace).values()].slice(0, request.limit),
		);
	}

	seed(namespace: string, record: TencentDbCoreRecord): void {
		this.forNamespace(namespace).set(record.id, record);
	}

	private forNamespace(namespace: string): Map<string, TencentDbCoreRecord> {
		let records = this.records.get(namespace);
		if (!records) {
			records = new Map();
			this.records.set(namespace, records);
		}
		return records;
	}

	private get(namespace: string, id: string): TencentDbCoreRecord {
		const record = this.forNamespace(namespace).get(id);
		if (!record) throw new Error(`missing fake memory ${id}`);
		return record;
	}
}

function rememberRequest(scope: MemoryBankScope, text: string) {
	return {
		scope,
		text,
		provenance,
		importance: 0.7,
		metadata: { source: "test" } satisfies MemoryMetadata,
	};
}

describe("TencentDB memory backend", () => {
	it("keeps installation, user, and companion banks isolated", async () => {
		const core = new FakeTencentDbCore();
		const backend = new TencentDbMemoryBackend(core);

		await backend.open({ scope: scopeA });
		await backend.remember(rememberRequest(scopeA, "A-only memory"));
		await backend.open({ scope: scopeB });
		await backend.remember(rememberRequest(scopeB, "B-only memory"));

		const hits = await backend.recall({ scope: scopeB, query: "memory" });
		expect(hits).toHaveLength(1);
		expect(hits[0]?.record.text).toBe("B-only memory");
		expect(hits[0]?.record.scope).toEqual(scopeB);
		expect(
			core.calls.filter((call) => call.method === "remember").map((call) => call.request.namespace),
		).toEqual(["memory:v1:install-a:user-a:companion-a", "memory:v1:install-b:user-a:companion-a"]);
	});
	it("derives canonical and one-time legacy namespace identities", () => {
		expect(namespaceFor(scopeA)).toBe("memory:v1:install-a:user-a:companion-a");
		expect(legacyNamespaceFor(scopeA)).toBe("cyber-bear:install-a:user-a:companion-a");
		expect(legacyNamespaceFor(scopeA, "legacy-install")).toBe(
			"cyber-bear:legacy-install:user-a:companion-a",
		);
	});

	it("surfaces a recovery-required error for conflicting legacy and canonical IDs", async () => {
		const core = new FakeTencentDbCore();
		const legacyRecord: TencentDbCoreRecord = {
			id: "shared-memory",
			text: "legacy text",
			provenance,
			importance: 0.8,
			status: "invalidated",
			metadata: { replacementMemoryId: "replacement-memory" },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
			invalidatedAt: "2026-01-02T00:00:00.000Z",
		};
		core.seed(legacyNamespaceFor(scopeA), legacyRecord);
		core.seed(namespaceFor(scopeA), { ...legacyRecord, text: "canonical conflict" });

		const backend = new TencentDbMemoryBackend(core);
		await expect(backend.open({ scope: scopeA })).rejects.toMatchObject({
			code: "recovery_required",
		});
		await expect(backend.diagnostics()).resolves.toMatchObject({ state: "closed" });
	});

	it("retains Tdai activity metadata without asserting arbitrary Host metadata", async () => {
		const core = new FakeTencentDbCore();
		const backend = new TencentDbMemoryBackend(core);
		await backend.open({ scope: scopeA });

		const record = await backend.remember({
			scope: scopeA,
			text: "dated activity memory",
			provenance,
			metadata: {
				activity_start_time: "2026-01-02T09:00:00.000Z",
				activity_end_time: "2026-01-02T10:00:00.000Z",
				hostOnlyLabel: "host-owned context",
			} satisfies MemoryMetadata,
		});

		expect(record.metadata).toMatchObject({
			activity_start_time: "2026-01-02T09:00:00.000Z",
			activity_end_time: "2026-01-02T10:00:00.000Z",
		});
	});

	it("delegates every direct mutation with the active namespace", async () => {
		const core = new FakeTencentDbCore();
		const backend = new TencentDbMemoryBackend(core);
		await backend.open({ scope: scopeA });

		const created = await backend.remember(rememberRequest(scopeA, "mutable memory"));
		await backend.update({ scope: scopeA, memoryId: created.id, text: "updated memory" });
		await backend.setImportance({ scope: scopeA, memoryId: created.id, importance: 0.95 });
		await backend.invalidate({
			scope: scopeA,
			memoryId: created.id,
			replacementMemoryId: "replacement-memory",
		});
		await backend.forget({ scope: scopeA, memoryId: created.id });

		expect(core.calls.map((call) => call.method)).toEqual([
			"migrateNamespace",
			"remember",
			"update",
			"setImportance",
			"invalidate",
			"forget",
		]);
		for (const call of core.calls.filter((item) => item.method !== "migrateNamespace")) {
			expect(call.request.namespace).toBe("memory:v1:install-a:user-a:companion-a");
		}
		expect(core.calls[2]?.request).toMatchObject({ memoryId: created.id, text: "updated memory" });
		expect(core.calls[3]?.request).toMatchObject({ memoryId: created.id, importance: 0.95 });
		expect(core.calls[4]?.request).toMatchObject({
			memoryId: created.id,
			replacementMemoryId: "replacement-memory",
		});
		expect(core.calls[5]?.request).toMatchObject({ memoryId: created.id });
	});

	it("delegates panel mutations through the direct memory contract", async () => {
		const core = new FakeTencentDbCore();
		const backend = new TencentDbMemoryBackend(core);
		await backend.open({ scope: scopeA });

		const created = await backend.remember(rememberRequest(scopeA, "panel memory"));
		await backend.update({ scope: scopeA, memoryId: created.id, text: "edited panel memory" });
		await backend.invalidate({
			scope: scopeA,
			memoryId: created.id,
			replacementMemoryId: "replacement-memory",
		});
		await backend.setImportance({ scope: scopeA, memoryId: created.id, importance: 1 });
		await backend.forget({ scope: scopeA, memoryId: created.id });

		expect(core.calls.map((call) => call.method)).toEqual([
			"migrateNamespace",
			"remember",
			"update",
			"invalidate",
			"setImportance",
			"forget",
		]);
		expect(
			core.calls
				.filter((call) => call.method !== "migrateNamespace")
				.every((call) => call.request.namespace === "memory:v1:install-a:user-a:companion-a"),
		).toBe(true);
		expect(core.calls[2]?.request).toMatchObject({
			memoryId: created.id,
			text: "edited panel memory",
		});
		expect(core.calls[3]?.request).toMatchObject({
			memoryId: created.id,
			replacementMemoryId: "replacement-memory",
		});
		expect(core.calls[4]?.request).toMatchObject({
			memoryId: created.id,
			importance: 1,
		});
		expect(core.calls[5]?.request).toMatchObject({ memoryId: created.id });
	});
	it("rejects invalid scope and aborted requests before invoking core", async () => {
		const core = new FakeTencentDbCore();
		const backend = new TencentDbMemoryBackend(core);
		await backend.open({ scope: scopeA });

		await expect(
			backend.remember(rememberRequest({ ...scopeA, userId: "user:ambiguous" }, "invalid scope")),
		).rejects.toMatchObject({ code: "invalid_scope", operation: "remember" });
		expect(core.calls).toHaveLength(1);

		const controller = new AbortController();
		controller.abort();
		await expect(
			backend.remember({
				...rememberRequest(scopeA, "aborted request"),
				signal: controller.signal,
			}),
		).rejects.toThrow("TencentDB memory operation aborted");
		expect(core.calls).toHaveLength(1);
	});

	it("rejects ambiguous scope components", async () => {
		const backend = new TencentDbMemoryBackend(new FakeTencentDbCore());
		await expect(
			backend.open({ scope: { ...scopeA, userId: "user:ambiguous" } }),
		).rejects.toMatchObject({ code: "invalid_scope", operation: "open" });
	});
});

describe("Host memory acceptance boundary", () => {
	it("keeps scope selection and operations in one queue through notification", async () => {
		const backend = new TencentDbMemoryBackend(new FakeTencentDbCore());
		await backend.open({ scope: scopeA });
		await backend.open({ scope: scopeB });
		const gate = Promise.withResolvers<void>();
		const original = backend.remember.bind(backend);
		const write = vi.spyOn(backend, "remember").mockImplementation(async (request) => {
			await gate.promise;
			return original(request);
		});
		const notify = vi.fn();
		const read = vi.spyOn(backend, "list");
		const managed = withMemoryNotifications(backend, notify);
		const pendingWrite = managed.remember(rememberRequest(scopeA, "new memory"));
		await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
		const pendingRead = managed.list({ scope: scopeA }).then((records) => {
			expect(notify).toHaveBeenCalledOnce();
			return records;
		});
		const otherBank = managed.list({ scope: scopeB });
		expect(read).not.toHaveBeenCalled();
		gate.resolve();
		await pendingWrite;
		await expect(pendingRead).resolves.toMatchObject([{ text: "new memory" }]);
		await expect(otherBank).resolves.toEqual([]);
		await managed.close();
	});

	it("reconciles uncertain writes without retrying their side effect", async () => {
		const backend = new TencentDbMemoryBackend(new FakeTencentDbCore());
		await backend.open({ scope: scopeA });
		const original = backend.remember.bind(backend);
		const write = vi.spyOn(backend, "remember").mockImplementation(async (request) => {
			await original(request);
			throw new Error("reply lost after commit");
		});
		const notify = vi.fn();
		const managed = withMemoryNotifications(backend, notify);
		await expect(managed.remember(rememberRequest(scopeA, "committed"))).rejects.toThrow(
			"reply lost",
		);
		expect(notify).toHaveBeenCalledOnce();
		await expect(managed.list({ scope: scopeA })).resolves.toMatchObject([{ text: "committed" }]);
		expect(write).toHaveBeenCalledOnce();
		await managed.close();
	});

	it("retires pending reads and suppresses late write notifications on Host close", async () => {
		const backend = new TencentDbMemoryBackend(new FakeTencentDbCore());
		const gate = Promise.withResolvers<void>();
		const write = vi.spyOn(backend, "forget").mockImplementation(() => gate.promise);
		const read = vi.spyOn(backend, "list");
		const notify = vi.fn();
		const lifetime = new AbortController();
		const managed = withMemoryNotifications(backend, notify, lifetime.signal);
		const pendingWrite = managed.forget({ scope: scopeA, memoryId: "remote" });
		await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
		const pendingRead = managed.list({ scope: scopeA });
		const checks = [
			expect(pendingWrite).rejects.toMatchObject({ name: "AbortError" }),
			expect(pendingRead).rejects.toMatchObject({ name: "AbortError" }),
		];
		lifetime.abort();
		await Promise.all(checks);
		gate.resolve();
		await gate.promise;
		await Promise.resolve();
		expect(notify).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		await managed.close();
	});
});
