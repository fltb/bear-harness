// @vitest-environment node

import { CacheKey } from "@bear-harness/protocol/schema";
import { describe, expect, it, vi } from "vitest";
import { InvalidationHub } from "../src/storage/invalidation-hub.js";

describe("InvalidationHub", () => {
	it("fans one transient notice out to every current subscriber", () => {
		const hub = new InvalidationHub();
		const first = vi.fn();
		const second = vi.fn();
		hub.subscribe(first);
		hub.subscribe(second);

		hub.invalidate(CacheKey.conversations(), CacheKey.conversations());

		expect(first).toHaveBeenCalledWith({
			keys: [["conversations"]],
		});
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("stores and replays nothing", () => {
		const hub = new InvalidationHub();
		hub.invalidate(CacheKey.runs());
		const listener = vi.fn();
		hub.subscribe(listener);

		expect(listener).not.toHaveBeenCalled();
	});

	it("isolates listener failures and supports unsubscribe", () => {
		const hub = new InvalidationHub();
		hub.subscribe(() => {
			throw new Error("consumer failed");
		});
		const listener = vi.fn();
		const unsubscribe = hub.subscribe(listener);

		expect(() => hub.invalidate(CacheKey.runs())).not.toThrow();
		unsubscribe();
		hub.invalidate(CacheKey.audit());

		expect(listener).toHaveBeenCalledTimes(1);
	});
});
