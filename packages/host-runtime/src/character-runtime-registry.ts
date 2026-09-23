import { requireCompanionId } from "./storage/layout.js";

export interface CharacterResource {
	readonly characterId: string;
	/** Refuse destructive removal while an executor still owns runtime resources. */
	verifyDelete?(): void | Promise<void>;
	/** Revoke producers and stop executors before waiting for admitted operations. */
	stop(): Promise<void>;
	/** Flush and close the exact owned resources after admitted operations finish. */
	close(): Promise<void>;
}

interface Entry<R> {
	readonly opening?: Promise<R>;
	resource?: R;
	readonly removals: Array<() => Promise<void>>;
	users: number;
	blocked: boolean;
	drained?: () => void;
	closing?: Promise<void>;
}

/** The sole lifetime owner for each character. Selection is deliberately absent. */
export class CharacterRuntimeRegistry<R extends CharacterResource> {
	private readonly entries = new Map<string, Entry<R>>();
	private shuttingDown = false;

	constructor(
		private readonly create: (characterId: string, retain: (resource: R) => void) => Promise<R>,
	) {}

	async use<T>(characterId: string, operation: (resource: R) => T | Promise<T>): Promise<T> {
		const id = requireCompanionId(characterId);
		if (this.shuttingDown) throw { kind: "unavailable", reason: "host_closed" };
		let entry = this.entries.get(id);
		if (entry?.blocked) throw { kind: "conflict", reason: "character_runtime_closing" };
		if (!entry) {
			entry = {
				opening: Promise.resolve().then(async (): Promise<R> => {
					const resource = await this.create(id, (resource) => {
						if (resource.characterId !== id || owned.resource)
							throw new Error("invalid character resource ownership");
						owned.resource = resource;
					});
					if (resource.characterId !== id || (owned.resource && owned.resource !== resource))
						throw new Error("invalid character resource ownership");
					owned.resource = resource;
					return resource;
				}),
				users: 0,
				blocked: false,
				removals: [],
			};
			this.entries.set(id, entry);
			const owned: Entry<R> = entry;
			void entry.opening?.catch(() => {
				if (owned.resource) owned.blocked = true;
				else if (!owned.blocked && this.entries.get(id) === owned) this.entries.delete(id);
			});
		}
		entry.users++;
		try {
			const resource = await entry.opening;
			if (entry.blocked || !resource)
				throw { kind: "conflict", reason: "character_runtime_closing" };
			return await operation(resource);
		} finally {
			entry.users--;
			if (!entry.users) entry.drained?.();
		}
	}

	/** Visits only retained resources; never opens another character as a side effect. */
	async visitOpen(operation: (resource: R) => void | Promise<void>): Promise<void> {
		await Promise.all(
			[...this.entries].filter(([, e]) => !e.blocked).map(([id]) => this.use(id, operation)),
		);
	}

	close(characterId: string): Promise<void> {
		return this.remove(characterId, async () => undefined);
	}

	/** The deletion callback runs while admissions remain blocked, including for a cold runtime. */
	async deleteRuntime<T>(characterId: string, removeFiles: () => T | Promise<T>): Promise<T> {
		if (this.shuttingDown) throw { kind: "unavailable", reason: "host_closed" };
		let result!: T;
		await this.remove(
			characterId,
			async () => {
				result = await removeFiles();
			},
			true,
		);
		return result;
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.close(id)));
		const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
		if (errors.length) throw new AggregateError(errors, "character runtime shutdown failed");
	}

	private async remove(
		id: string,
		afterClose: () => Promise<void>,
		deleting = false,
	): Promise<void> {
		id = requireCompanionId(id);
		let entry = this.entries.get(id);
		if (!entry) {
			if (!deleting) return;
			// A cold deletion needs an admission fence, not an opened database.
			entry = { users: 0, blocked: true, removals: [] };
			this.entries.set(id, entry);
		}
		if (deleting) entry.removals.push(afterClose);
		if (entry.closing) return entry.closing;
		entry.blocked = true;
		const owned: Entry<R> = entry;
		owned.closing = (async () => {
			const opened = await owned.opening?.catch(() => undefined);
			const resource = owned.resource ?? opened;
			const drain = owned.users
				? new Promise<void>((resolve) => {
						owned.drained = resolve;
					})
				: Promise.resolve();
			// A failed stop must return so the same owner can be retried, even if its
			// admitted operations still need a successful stop to release their waits.
			await resource?.stop();
			await drain;
			if (owned.removals.length) await resource?.verifyDelete?.();
			await resource?.close();
			while (owned.removals.length) {
				const remove = owned.removals.shift();
				await remove?.();
			}
			if (this.entries.get(id) === owned) this.entries.delete(id);
		})();
		try {
			await owned.closing;
		} catch (error) {
			owned.removals.length = 0;
			throw error;
		} finally {
			owned.closing = undefined;
		}
	}
}
