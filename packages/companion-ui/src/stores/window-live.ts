import type { CompanionClient } from "@bear-harness/companion-client";
import type { LivePush } from "@bear-harness/protocol";

type Subscriber = {
	queue: LivePush[];
	wake?: () => void;
	stopped: boolean;
	failure?: unknown;
};
type Connection = {
	controller: AbortController;
	subscribers: Set<Subscriber>;
	ready: Promise<void>;
	finished: boolean;
	failure?: unknown;
};

/** A window owns one physical stream; character projections consume independent transient queues. */
export function shareWindowLive(source: CompanionClient["live"]): CompanionClient["live"] {
	let connection: Connection | undefined;
	return {
		async subscribe(signal) {
			if (signal.aborted) throw signal.reason ?? new Error("Live subscription aborted");
			let current = connection;
			if (!current) {
				const controller = new AbortController();
				let resolveConnected!: () => void;
				let rejectConnected!: (cause: unknown) => void;
				const ready = new Promise<void>((resolve, reject) => {
					resolveConnected = resolve;
					rejectConnected = reject;
				});
				current = { controller, subscribers: new Set(), ready, finished: false };
				connection = current;
				const owned = current;
				void (async () => {
					try {
						const events = await source.subscribe(controller.signal);
						resolveConnected();
						for await (const event of events) {
							if (controller.signal.aborted) break;
							for (const subscriber of owned.subscribers) {
								if (subscriber.failure !== undefined) continue;
								if (subscriber.queue.length >= 10000) {
									subscriber.queue.length = 0;
									subscriber.failure = new Error("Character projection consumer overflow");
								} else subscriber.queue.push(event);
								subscriber.wake?.();
							}
						}
					} catch (cause) {
						owned.failure = cause;
						rejectConnected(cause);
					} finally {
						owned.finished = true;
						controller.abort();
						if (connection === owned) connection = undefined;
						for (const subscriber of owned.subscribers) subscriber.wake?.();
					}
				})();
			}
			const owned = current;
			const subscriber: Subscriber = { queue: [], stopped: false };
			owned.subscribers.add(subscriber);
			const stop = () => {
				subscriber.stopped = true;
				subscriber.queue.length = 0;
				owned.subscribers.delete(subscriber);
				subscriber.wake?.();
				signal.removeEventListener("abort", stop);
				if (!owned.subscribers.size) {
					owned.controller.abort();
					if (connection === owned) connection = undefined;
				}
			};
			signal.addEventListener("abort", stop, { once: true });
			try {
				await owned.ready;
			} catch (cause) {
				stop();
				throw cause;
			}
			if (signal.aborted) {
				stop();
				throw signal.reason ?? new Error("Live subscription aborted");
			}
			return {
				async *[Symbol.asyncIterator]() {
					try {
						while (!subscriber.stopped) {
							if (subscriber.failure !== undefined) throw subscriber.failure;
							if (owned.finished) {
								if (owned.failure !== undefined) throw owned.failure;
								return;
							}
							const event = subscriber.queue.shift();
							if (event) {
								yield event;
								continue;
							}
							await new Promise<void>((resolve) => {
								subscriber.wake = resolve;
							});
							subscriber.wake = undefined;
						}
					} finally {
						stop();
					}
				},
			};
		},
	};
}
