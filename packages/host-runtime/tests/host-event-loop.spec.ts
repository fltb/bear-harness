import { describe, expect, it, vi } from "vitest";
import { HostEventLoop, type RuntimeResource } from "../src/host-event-loop.js";

interface TestResource extends RuntimeResource {
	readonly label: string;
}

function resource(
	runtimeId: string,
	characterId: string,
): TestResource & { close: ReturnType<typeof vi.fn> } {
	return {
		runtimeId,
		characterId,
		label: characterId,
		close: vi.fn(async () => undefined),
	};
}

describe("HostEventLoop", () => {
	it("pins routed work to its immutable runtime while activation swaps the active runtime", async () => {
		const first = resource("bear:1", "bear");
		const next = resource("fox:2", "fox");
		const loop = new HostEventLoop(first);
		let finish: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const routed = loop.route(async (selected) => {
			expect(selected).toBe(first);
			await pending;
			return selected.label;
		});
		await vi.waitFor(() => expect(loop.snapshot().runtimes["bear:1"]?.pendingRequests).toBe(1));

		await loop.activate(
			"fox",
			async () => next,
			() => undefined,
		);
		expect(loop.active()).toBe(next);
		expect(loop.snapshot()).toMatchObject({
			activeRuntimeId: "fox:2",
			runtimes: { "bear:1": { phase: "retiring", pendingRequests: 1 } },
		});
		expect(Object.isFrozen(loop.snapshot())).toBe(true);
		expect(first.close).not.toHaveBeenCalled();

		finish?.();
		await expect(routed).resolves.toBe("bear");
		expect(first.close).toHaveBeenCalledOnce();
		expect(loop.snapshot().runtimes["bear:1"]).toBeUndefined();
		await loop.close();
	});

	it("refreshes the active runtime without creating or replacing it", async () => {
		const first = resource("bear:1", "bear");
		const loop = new HostEventLoop(first);
		const create = vi.fn(async () => resource("bear:2", "bear"));
		const refresh = vi.fn();

		await expect(loop.activate("bear", create, refresh)).resolves.toBe(first);
		expect(create).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledWith(first);
		expect(first.close).not.toHaveBeenCalled();
		await loop.close();
	});

	it("closes an idle previous runtime immediately after activation", async () => {
		const first = resource("bear:1", "bear");
		const next = resource("fox:2", "fox");
		const loop = new HostEventLoop(first);

		await loop.activate(
			"fox",
			async () => next,
			() => undefined,
		);
		expect(first.close).toHaveBeenCalledOnce();
		expect(loop.snapshot().runtimes).toEqual({
			"fox:2": expect.objectContaining({ phase: "active", pendingRequests: 0 }),
		});
		await loop.close();
	});

	it("waits for routed work before closing its runtime", async () => {
		const first = resource("bear:1", "bear");
		const loop = new HostEventLoop(first);
		let finish: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const routed = loop.route(async () => pending);
		await vi.waitFor(() => expect(loop.snapshot().runtimes["bear:1"]?.pendingRequests).toBe(1));

		const closing = loop.close();
		await vi.waitFor(() => expect(loop.snapshot().runtimes["bear:1"]?.phase).toBe("closing"));
		expect(first.close).not.toHaveBeenCalled();

		finish?.();
		await routed;
		await closing;
		expect(first.close).toHaveBeenCalledOnce();
	});

	it.each(["resolve", "reject"] as const)(
		"retires a pinned runtime after routed work ends by %s",
		async (outcome) => {
			const first = resource("bear:1", "bear");
			const next = resource("fox:2", "fox");
			const work = Promise.withResolvers<void>();
			const loop = new HostEventLoop(first);
			const routed = loop.route(async () => {
				await work.promise;
				if (outcome === "reject") throw new Error("route failed");
				return "done";
			});
			await vi.waitFor(() => expect(loop.snapshot().runtimes["bear:1"]?.pendingRequests).toBe(1));
			await loop.activate(
				"fox",
				async () => next,
				() => undefined,
			);
			expect(first.close).not.toHaveBeenCalled();

			work.resolve();
			if (outcome === "resolve") await expect(routed).resolves.toBe("done");
			else await expect(routed).rejects.toThrow("route failed");
			await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
			expect(loop.active()).toBe(next);
			await loop.close();
		},
	);

	it("serializes concurrent activations and leaves the last accepted character active", async () => {
		const first = resource("bear:1", "bear");
		const fox = resource("fox:2", "fox");
		const owl = resource("owl:3", "owl");
		const foxCreation = Promise.withResolvers<void>();
		const loop = new HostEventLoop(first);
		const activateFox = loop.activate(
			"fox",
			async () => {
				await foxCreation.promise;
				return fox;
			},
			() => undefined,
		);
		const createOwl = vi.fn(async () => owl);
		const activateOwl = loop.activate("owl", createOwl, () => undefined);
		await Promise.resolve();
		expect(createOwl).not.toHaveBeenCalled();

		foxCreation.resolve();
		await expect(activateFox).resolves.toBe(fox);
		await expect(activateOwl).resolves.toBe(owl);
		expect(loop.active()).toBe(owl);
		expect(first.close).toHaveBeenCalledOnce();
		expect(fox.close).toHaveBeenCalledOnce();
		expect(owl.close).not.toHaveBeenCalled();
		await loop.close();
	});

	it("keeps the current runtime authoritative when replacement creation fails", async () => {
		const first = resource("bear:1", "bear");
		const loop = new HostEventLoop(first);

		await expect(
			loop.activate(
				"fox",
				async () => Promise.reject(new Error("create failed")),
				() => undefined,
			),
		).rejects.toThrow("create failed");
		expect(loop.active()).toBe(first);
		expect(loop.snapshot().runtimes).toEqual({
			"bear:1": expect.objectContaining({ phase: "active", pendingRequests: 0 }),
		});
		expect(first.close).not.toHaveBeenCalled();
		await loop.close();
	});

	it("finishes an accepted activation before close and rejects later routing", async () => {
		const first = resource("bear:1", "bear");
		const next = resource("fox:2", "fox");
		const creation = Promise.withResolvers<void>();
		const loop = new HostEventLoop(first);
		const activating = loop.activate(
			"fox",
			async () => {
				await creation.promise;
				return next;
			},
			() => undefined,
		);
		const closing = loop.close();
		const rejectedRoute = expect(loop.route(async () => undefined)).rejects.toThrow(
			"Host event loop is closed",
		);

		creation.resolve();
		await expect(activating).resolves.toBe(next);
		await closing;
		await rejectedRoute;
		expect(first.close).toHaveBeenCalledOnce();
		expect(next.close).toHaveBeenCalledOnce();
	});
});
