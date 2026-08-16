/**
 * Append-only event bus with snapshot + afterSeq subscription.
 *
 * Every state change is committed to the canonical DB first, then an event
 * is published. The renderer takes a snapshot on boot (via `snapshot.get:v1`)
 * then subscribes with `events.subscribe:v1` specifying `afterSeq`.
 * Duplicate events are idempotent; gaps or missed subscriptions cause the
 * renderer to discard its optimistic projection and re-fetch the snapshot.
 */

import { asc, gt, max } from "drizzle-orm";
import type { AppDatabase } from "./database.js";
import { events } from "./schema.js";

export interface HostEvent {
	seq: number;
	kind: string;
	payload: unknown;
}

export type EventListener = (event: HostEvent) => void;

export class EventBus {
	private db: AppDatabase;
	private listeners = new Set<EventListener>();
	private seq = 0;

	constructor(db: AppDatabase) {
		this.db = db;
		this.seq =
			db
				.select({ value: max(events.seq) })
				.from(events)
				.get()?.value ?? 0;
	}

	/** Publish an event: write to DB, then notify all listeners. */
	publish(kind: string, payload: unknown): HostEvent {
		this.seq += 1;
		this.db
			.insert(events)
			.values({ seq: this.seq, kind, payload: payload ?? {} })
			.run();
		const event: HostEvent = { seq: this.seq, kind, payload };
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* listener error — swallow */
			}
		}
		return event;
	}

	/** Subscribe to events after a given sequence number. */
	subscribe(listener: EventListener, afterSeq?: number): () => void {
		this.listeners.add(listener);

		// Catch up: replay events after the given seq
		if (afterSeq !== undefined && afterSeq > 0) {
			const rows = this.db
				.select({ seq: events.seq, kind: events.kind, payload: events.payload })
				.from(events)
				.where(gt(events.seq, afterSeq))
				.orderBy(asc(events.seq))
				.all();
			for (const row of rows) {
				listener(row);
			}
		}

		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Get the current event sequence number. */
	get currentSeq(): number {
		return this.seq;
	}
}
