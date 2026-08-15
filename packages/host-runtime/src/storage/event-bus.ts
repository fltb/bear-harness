/**
 * Append-only event bus with snapshot + afterSeq subscription.
 *
 * Every state change is committed to the canonical DB first, then an event
 * is published. The renderer takes a snapshot on boot (via `snapshot.get:v1`)
 * then subscribes with `events.subscribe:v1` specifying `afterSeq`.
 * Duplicate events are idempotent; gaps or missed subscriptions cause the
 * renderer to discard its optimistic projection and re-fetch the snapshot.
 */

import type { DatabaseSync } from "node:sqlite";

export interface HostEvent {
	seq: number;
	kind: string;
	payload: unknown;
}

export type EventListener = (event: HostEvent) => void;

export class EventBus {
	private db: DatabaseSync;
	private listeners = new Set<EventListener>();
	private seq = 0;

	constructor(db: DatabaseSync) {
		this.db = db;
		// Restore the last sequence from the DB
		const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number };
		this.seq = row.s;
	}

	/** Publish an event: write to DB, then notify all listeners. */
	publish(kind: string, payload: unknown): HostEvent {
		this.seq += 1;
		const json = JSON.stringify(payload ?? {});
		this.db
			.prepare("INSERT INTO events (seq, kind, payload) VALUES (?, ?, ?)")
			.run(this.seq, kind, json);
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
				.prepare("SELECT seq, kind, payload FROM events WHERE seq > ? ORDER BY seq")
				.all(afterSeq) as Array<{ seq: number; kind: string; payload: string }>;
			for (const row of rows) {
				listener({ seq: row.seq, kind: row.kind, payload: JSON.parse(row.payload) });
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
