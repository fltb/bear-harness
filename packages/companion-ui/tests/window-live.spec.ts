import type { LivePush } from "@bear-harness/protocol";
import { describe, expect, it, vi } from "vitest";
import { shareWindowLive } from "../src/stores/window-live.js";

describe("window live transport ownership", () => {
	it("rejects all waiting projections when connection establishment fails and permits a fresh connection", async () => {
		const connection = Promise.withResolvers<AsyncIterable<LivePush>>();
		const signals: AbortSignal[] = [];
		const source = {
			subscribe: vi.fn((signal: AbortSignal) => {
				signals.push(signal);
				return connection.promise;
			}),
		};
		const live = shareWindowLive(source);
		const first = live.subscribe(new AbortController().signal);
		const second = live.subscribe(new AbortController().signal);
		const firstFailure = expect(first).rejects.toThrow("connection unavailable");
		const secondFailure = expect(second).rejects.toThrow("connection unavailable");
		connection.reject(new Error("connection unavailable"));
		await Promise.all([firstFailure, secondFailure]);
		expect(source.subscribe).toHaveBeenCalledTimes(1);
		expect(signals[0]?.aborted).toBe(true);
		source.subscribe.mockImplementation(async (signal) => {
			signals.push(signal);
			return {
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						return { done: true as const, value: undefined };
					},
				}),
			};
		});
		const controller = new AbortController();
		await live.subscribe(controller.signal);
		controller.abort();
		expect(signals[1]?.aborted).toBe(true);
		expect(source.subscribe).toHaveBeenCalledTimes(2);
	});

	it("never starts transport for an already closed projection", async () => {
		const subscribe = vi.fn();
		const controller = new AbortController();
		controller.abort(new Error("window closed"));
		await expect(shareWindowLive({ subscribe }).subscribe(controller.signal)).rejects.toThrow(
			"window closed",
		);
		expect(subscribe).not.toHaveBeenCalled();
	});

	it("bounds events retained by a projection waiting on its snapshot and requires fresh recovery on overflow", async () => {
		const produced = Promise.withResolvers<void>();
		let physical: AbortSignal | undefined;
		const event: LivePush = {
			type: "pi",
			characterId: "jizhou",
			conversationId: "session",
			event: { type: "agent_settled" },
		};
		const live = shareWindowLive({
			subscribe: async (signal) => {
				physical = signal;
				return {
					async *[Symbol.asyncIterator]() {
						for (let index = 0; index < 10001; index++) yield event;
						produced.resolve();
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve(), { once: true }),
						);
					},
				};
			},
		});
		const events = await live.subscribe(new AbortController().signal);
		await produced.promise;
		await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow("consumer overflow");
		expect(physical?.aborted).toBe(true);
	});
});
