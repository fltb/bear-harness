import { freeze, produce } from "immer";
import PQueue from "p-queue";

export type RuntimePhase = "active" | "retiring" | "closing";

export interface RuntimeLifecycleState {
	readonly characterId: string;
	readonly generation: number;
	readonly phase: RuntimePhase;
	readonly pendingRequests: number;
}

export interface HostLifecycleState {
	readonly activeRuntimeId: string;
	readonly runtimes: Readonly<Record<string, RuntimeLifecycleState>>;
}

export interface RuntimeResource {
	readonly runtimeId: string;
	readonly characterId: string;
	close(): Promise<void>;
}

/**
 * Single-consumer Host lifecycle event loop.
 *
 * It orders only resource routing, activation and retirement. The routed work
 * itself runs outside the queue, so Pi sessions and independent conversations
 * remain concurrent. State is immutable; live resources stay in the registry.
 */
export class HostEventLoop<Resource extends RuntimeResource> {
	private readonly events = new PQueue({ concurrency: 1 });
	private readonly resources = new Map<string, Resource>();
	private state: HostLifecycleState;
	private nextGeneration: number;
	private closed = false;
	private closePromise: Promise<void> | undefined;
	private closeResolve: (() => void) | undefined;
	private closeFailure: unknown;

	constructor(initial: Resource) {
		this.resources.set(initial.runtimeId, initial);
		this.nextGeneration = 2;
		this.state = freeze({
			activeRuntimeId: initial.runtimeId,
			runtimes: {
				[initial.runtimeId]: {
					characterId: initial.characterId,
					generation: 1,
					phase: "active",
					pendingRequests: 0,
				},
			},
		});
	}

	snapshot(): HostLifecycleState {
		return this.state;
	}

	active(): Resource {
		const resource = this.resources.get(this.state.activeRuntimeId);
		if (!resource) throw new Error("active character runtime is unavailable");
		return resource;
	}

	async route<Result>(run: (resource: Resource) => Promise<Result>): Promise<Result> {
		const resource = await this.events.add(() => {
			this.requireOpen();
			const runtimeId = this.state.activeRuntimeId;
			const selected = this.resources.get(runtimeId);
			if (!selected) throw new Error("active character runtime is unavailable");
			this.state = produce(this.state, (draft) => {
				const runtime = draft.runtimes[runtimeId];
				if (!runtime) throw new Error("active character runtime state is unavailable");
				runtime.pendingRequests += 1;
			});
			return selected;
		});
		if (!resource) throw new Error("active character runtime is unavailable");
		try {
			return await run(resource);
		} finally {
			await this.events.add(() => this.settle(resource.runtimeId));
		}
	}

	async activate(
		characterId: string,
		create: (runtimeId: string) => Promise<Resource>,
		refresh: (resource: Resource) => Promise<void> | void,
	): Promise<Resource> {
		const resource = await this.events.add(async () => {
			this.requireOpen();
			const current = this.active();
			if (current.characterId === characterId) {
				await refresh(current);
				return current;
			}

			const generation = this.nextGeneration++;
			const runtimeId = `${characterId}:${generation}`;
			const next = await create(runtimeId);
			if (next.runtimeId !== runtimeId || next.characterId !== characterId) {
				await next.close().catch(() => undefined);
				throw new Error("character runtime identity mismatch");
			}
			const previousRuntimeId = this.state.activeRuntimeId;
			this.resources.set(runtimeId, next);
			this.state = produce(this.state, (draft) => {
				const previous = draft.runtimes[draft.activeRuntimeId];
				if (!previous) throw new Error("active character runtime state is unavailable");
				previous.phase = "retiring";
				draft.runtimes[runtimeId] = {
					characterId,
					generation,
					phase: "active",
					pendingRequests: 0,
				};
				draft.activeRuntimeId = runtimeId;
			});
			await this.closeRetired(previousRuntimeId);
			return next;
		});
		if (!resource) throw new Error("character activation did not produce a runtime");
		return resource;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = (async () => {
			await this.events.add(async () => {
				this.state = produce(this.state, (draft) => {
					for (const runtime of Object.values(draft.runtimes)) runtime.phase = "closing";
				});
				for (const runtimeId of Object.keys(this.state.runtimes)) {
					if (this.state.runtimes[runtimeId]?.pendingRequests === 0) {
						await this.closeResource(runtimeId, true);
					}
				}
			});
			if (this.resources.size > 0) {
				await new Promise<void>((resolve) => {
					this.closeResolve = resolve;
					if (this.resources.size === 0) resolve();
				});
			}
			this.events.clear();
			if (this.closeFailure) throw this.closeFailure;
		})();
		return this.closePromise;
	}

	private async settle(runtimeId: string): Promise<void> {
		const runtime = this.state.runtimes[runtimeId];
		if (!runtime) return;
		if (runtime.pendingRequests <= 0) throw new Error("character runtime request count underflow");
		this.state = produce(this.state, (draft) => {
			const current = draft.runtimes[runtimeId];
			if (!current) throw new Error("character runtime state is unavailable");
			current.pendingRequests -= 1;
		});
		const current = this.state.runtimes[runtimeId];
		if (current?.phase === "closing" && current.pendingRequests === 0) {
			await this.closeResource(runtimeId, true);
			return;
		}
		await this.closeRetired(runtimeId);
	}

	private async closeRetired(runtimeId: string): Promise<void> {
		const settled = this.state.runtimes[runtimeId];
		if (settled?.phase !== "retiring" || settled.pendingRequests !== 0) return;
		this.state = produce(this.state, (draft) => {
			const current = draft.runtimes[runtimeId];
			if (!current) throw new Error("character runtime state is unavailable");
			current.phase = "closing";
		});
		const resource = this.resources.get(runtimeId);
		try {
			if (resource) await resource.close();
		} catch {
			// The replacement is already authoritative. A retired resource cannot
			// roll activation back after its own shutdown has begun.
		} finally {
			this.resources.delete(runtimeId);
			this.state = produce(this.state, (draft) => {
				delete draft.runtimes[runtimeId];
			});
		}
	}

	private async closeResource(runtimeId: string, reportFailure: boolean): Promise<void> {
		const resource = this.resources.get(runtimeId);
		try {
			if (resource) await resource.close();
		} catch (error) {
			if (reportFailure) this.closeFailure ??= error;
		} finally {
			this.resources.delete(runtimeId);
			this.state = produce(this.state, (draft) => {
				delete draft.runtimes[runtimeId];
			});
			if (this.resources.size === 0) this.closeResolve?.();
		}
	}

	private requireOpen(): void {
		if (this.closed) throw new Error("Host event loop is closed");
	}
}
