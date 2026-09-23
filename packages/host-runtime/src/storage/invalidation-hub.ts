import type { CacheKey, InvalidationNotice } from "@bear-harness/protocol";

export type { InvalidationNotice };

export type InvalidationListener = (notice: InvalidationNotice) => void;

/** Process-local cache invalidation fan-out. It stores and replays nothing. */
export class InvalidationHub {
	private readonly listeners = new Set<InvalidationListener>();

	constructor(
		private readonly scope: { scope: "system" } | { scope: "character"; characterId: string } = {
			scope: "system",
		},
	) {}

	invalidate(...keys: Readonly<CacheKey>[]): void {
		const unique = [
			...new Map(keys.map((key) => [JSON.stringify(key), [...key] as CacheKey])).values(),
		];
		if (unique.length === 0) return;
		const notice: InvalidationNotice = Object.freeze({ ...this.scope, keys: unique });
		for (const listener of [...this.listeners]) {
			try {
				listener(notice);
			} catch {
				// A notification consumer cannot interrupt the committed operation.
			}
		}
	}

	subscribe(listener: InvalidationListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
