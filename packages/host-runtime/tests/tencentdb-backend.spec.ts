// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { MemoryBankScope, MemoryMetadata } from "../src/memory/backend.js";
import {
	type TencentDbCoreHit,
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
		).toEqual([
			"cyber-bear:install-a:user-a:companion-a",
			"cyber-bear:install-b:user-a:companion-a",
		]);
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
			"remember",
			"update",
			"setImportance",
			"invalidate",
			"forget",
		]);
		for (const call of core.calls) {
			expect(call.request.namespace).toBe("cyber-bear:install-a:user-a:companion-a");
		}
		expect(core.calls[1]?.request).toMatchObject({ memoryId: created.id, text: "updated memory" });
		expect(core.calls[2]?.request).toMatchObject({ memoryId: created.id, importance: 0.95 });
		expect(core.calls[3]?.request).toMatchObject({
			memoryId: created.id,
			replacementMemoryId: "replacement-memory",
		});
		expect(core.calls[4]?.request).toMatchObject({ memoryId: created.id });
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
			"remember",
			"update",
			"invalidate",
			"setImportance",
			"forget",
		]);
		expect(
			core.calls.every(
				(call) => call.request.namespace === "cyber-bear:install-a:user-a:companion-a",
			),
		).toBe(true);
		expect(core.calls[1]?.request).toMatchObject({
			memoryId: created.id,
			text: "edited panel memory",
		});
		expect(core.calls[2]?.request).toMatchObject({
			memoryId: created.id,
			replacementMemoryId: "replacement-memory",
		});
		expect(core.calls[3]?.request).toMatchObject({
			memoryId: created.id,
			importance: 1,
		});
		expect(core.calls[4]?.request).toMatchObject({ memoryId: created.id });
	});
	it("rejects invalid scope and aborted requests before invoking core", async () => {
		const core = new FakeTencentDbCore();
		const backend = new TencentDbMemoryBackend(core);
		await backend.open({ scope: scopeA });

		await expect(
			backend.remember(rememberRequest({ ...scopeA, userId: "user:ambiguous" }, "invalid scope")),
		).rejects.toMatchObject({ code: "invalid_scope", operation: "remember" });
		expect(core.calls).toHaveLength(0);

		const controller = new AbortController();
		controller.abort();
		await expect(
			backend.remember({
				...rememberRequest(scopeA, "aborted request"),
				signal: controller.signal,
			}),
		).rejects.toThrow("TencentDB memory operation aborted");
		expect(core.calls).toHaveLength(0);
	});

	it("rejects ambiguous scope components", async () => {
		const backend = new TencentDbMemoryBackend(new FakeTencentDbCore());
		await expect(
			backend.open({ scope: { ...scopeA, userId: "user:ambiguous" } }),
		).rejects.toMatchObject({ code: "invalid_scope", operation: "open" });
	});
});
