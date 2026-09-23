import { describe, expect, it, vi } from "vitest";
import {
	type CharacterResource,
	CharacterRuntimeRegistry,
} from "../src/character-runtime-registry.js";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function resource(characterId: string): CharacterResource {
	return { characterId, stop: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}

describe("CharacterRuntimeRegistry", () => {
	it("deduplicates construction and keeps A alive across A/B/A requests", async () => {
		const opening = deferred<CharacterResource>();
		const first = resource("a");
		const second = resource("b");
		const create = vi.fn(async (id: string) => (id === "a" ? opening.promise : second));
		const registry = new CharacterRuntimeRegistry(create);
		const firstUse = registry.use("a", (r) => r);
		const concurrent = registry.use("a", (r) => r);
		expect(await registry.use("b", (r) => r)).toBe(second);
		opening.resolve(first);
		expect(await firstUse).toBe(first);
		expect(await concurrent).toBe(first);
		expect(await registry.use("a", (r) => r)).toBe(first);
		expect(create).toHaveBeenCalledTimes(2);
		expect(first.stop).not.toHaveBeenCalled();
		await registry.shutdown();
		expect(first.close).toHaveBeenCalledTimes(1);
		expect(second.close).toHaveBeenCalledTimes(1);
	});

	it("stops producers before draining requests and removes files after the exact owner closes", async () => {
		const pending = deferred();
		const entered = deferred();
		const order: string[] = [];
		const owned = {
			characterId: "a",
			stop: async () => {
				order.push("stop");
				pending.resolve();
			},
			close: async () => {
				order.push("close");
			},
		};
		const registry = new CharacterRuntimeRegistry(async () => owned);
		const operation = registry.use("a", async () => {
			entered.resolve();
			await pending.promise;
			order.push("request complete");
		});
		await entered.promise;
		const deletion = registry.deleteRuntime("a", () => {
			order.push("delete files");
			return true;
		});
		await expect(registry.use("a", () => {})).rejects.toMatchObject({
			reason: "character_runtime_closing",
		});
		expect(await deletion).toBe(true);
		await operation;
		expect(order).toEqual(["stop", "request complete", "close", "delete files"]);
	});

	it("fences a cold delete without constructing a database", async () => {
		const remove = deferred();
		const create = vi.fn(async (id: string) => resource(id));
		const registry = new CharacterRuntimeRegistry(create);
		const deletion = registry.deleteRuntime("a", () => remove.promise);
		await expect(registry.use("a", () => {})).rejects.toMatchObject({
			reason: "character_runtime_closing",
		});
		remove.resolve();
		await deletion;
		expect(create).not.toHaveBeenCalled();
		await registry.use("a", () => {});
		expect(create).toHaveBeenCalledTimes(1);
		await registry.shutdown();
	});

	it("waits for an opening owner and rejects its queued operation during deletion", async () => {
		const opening = deferred<CharacterResource>();
		const owned = resource("a");
		const registry = new CharacterRuntimeRegistry(async () => opening.promise);
		const callback = vi.fn();
		const use = registry.use("a", callback);
		const rejected = expect(use).rejects.toMatchObject({ reason: "character_runtime_closing" });
		const remove = vi.fn();
		const deletion = registry.deleteRuntime("a", remove);
		opening.resolve(owned);
		await deletion;
		await rejected;
		expect(callback).not.toHaveBeenCalled();
		expect(owned.close).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();
	});

	it("retains failed cleanup ownership and admits no replacement until retry succeeds", async () => {
		const owned = resource("a");
		vi.mocked(owned.close).mockRejectedValueOnce(new Error("flush failed"));
		const create = vi.fn(async () => owned);
		const registry = new CharacterRuntimeRegistry(create);
		await registry.use("a", () => {});
		const remove = vi.fn();
		await expect(registry.deleteRuntime("a", remove)).rejects.toThrow("flush failed");
		expect(remove).not.toHaveBeenCalled();
		await expect(registry.use("a", () => {})).rejects.toMatchObject({
			reason: "character_runtime_closing",
		});
		await registry.deleteRuntime("a", remove);
		expect(create).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();
	});

	it("returns a stop failure without deadlocking on requests that need stop to finish", async () => {
		const work = deferred();
		const entered = deferred();
		const owned = resource("a");
		vi.mocked(owned.stop)
			.mockRejectedValueOnce(new Error("stop failed"))
			.mockImplementationOnce(async () => work.resolve());
		const registry = new CharacterRuntimeRegistry(async () => owned);
		const admitted = registry.use("a", async () => {
			entered.resolve();
			await work.promise;
		});
		await entered.promise;
		await expect(registry.close("a")).rejects.toThrow("stop failed");
		expect(owned.close).not.toHaveBeenCalled();
		await registry.close("a");
		await admitted;
		expect(owned.stop).toHaveBeenCalledTimes(2);
		expect(owned.close).toHaveBeenCalledOnce();
	});

	it("retains a partially initialized owner after factory failure until exact disposal succeeds", async () => {
		const owned = resource("a");
		vi.mocked(owned.close).mockRejectedValueOnce(new Error("cleanup failed"));
		const create = vi.fn(async (_id: string, retain: (value: CharacterResource) => void) => {
			retain(owned);
			throw new Error("initialization failed");
		});
		const registry = new CharacterRuntimeRegistry(create);
		await expect(registry.use("a", () => {})).rejects.toThrow("initialization failed");
		await expect(registry.use("a", () => {})).rejects.toMatchObject({
			reason: "character_runtime_closing",
		});
		await expect(registry.close("a")).rejects.toThrow("cleanup failed");
		await registry.close("a");
		expect(owned.close).toHaveBeenCalledTimes(2);
		expect(create).toHaveBeenCalledOnce();
	});

	it("never routes a different resource than the retained lifetime owner", async () => {
		const owned = resource("a");
		const substitute = resource("a");
		const registry = new CharacterRuntimeRegistry(async (_id, retain) => {
			retain(owned);
			return substitute;
		});
		const operation = vi.fn();
		await expect(registry.use("a", operation)).rejects.toThrow(
			"invalid character resource ownership",
		);
		await registry.close("a");
		expect(operation).not.toHaveBeenCalled();
		expect(owned.close).toHaveBeenCalledOnce();
	});

	it("serializes concurrent close and delete behind the same exact owner", async () => {
		const stopped = deferred();
		const owned = resource("a");
		vi.mocked(owned.stop).mockImplementationOnce(() => stopped.promise);
		const registry = new CharacterRuntimeRegistry(async () => owned);
		await registry.use("a", () => {});
		const closing = registry.close("a");
		const remove = vi.fn(() => "removed");
		const deletion = registry.deleteRuntime("a", remove);
		stopped.resolve();
		await closing;
		expect(await deletion).toBe("removed");
		expect(owned.stop).toHaveBeenCalledOnce();
		expect(owned.close).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();
	});

	it("checks deletion after producers stop while keeping ordinary shutdown available", async () => {
		const owned = {
			...resource("a"),
			verifyDelete: vi.fn(() => {
				throw { kind: "conflict", reason: "unknown_executor" };
			}),
		};
		const registry = new CharacterRuntimeRegistry(async () => owned);
		await registry.use("a", () => {});
		const remove = vi.fn();
		await expect(registry.deleteRuntime("a", remove)).rejects.toMatchObject({
			reason: "unknown_executor",
		});
		expect(owned.stop).toHaveBeenCalledOnce();
		expect(owned.close).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		await registry.shutdown();
		expect(owned.close).toHaveBeenCalledOnce();
		expect(owned.verifyDelete).toHaveBeenCalledOnce();
	});

	it("recovers from construction failure and fences admissions during shutdown", async () => {
		const create = vi
			.fn()
			.mockRejectedValueOnce(new Error("open failed"))
			.mockResolvedValue(resource("a"));
		const registry = new CharacterRuntimeRegistry<CharacterResource>(create);
		await expect(registry.use("a", () => {})).rejects.toThrow("open failed");
		await registry.use("a", () => {});
		await registry.shutdown();
		await expect(registry.use("a", () => {})).rejects.toMatchObject({ reason: "host_closed" });
	});
});
