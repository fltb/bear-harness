/**
 * Append-only event bus with snapshot + afterSeq subscription.
 *
 * Every state change is committed to the canonical DB first, then an event
 * is published. The renderer takes a snapshot on boot (via `snapshot.get:v1`)
 * then subscribes with `events.subscribe:v1` specifying `afterSeq`.
 * Duplicate events are idempotent; gaps or missed subscriptions cause the
 * renderer to discard its optimistic projection and re-fetch the snapshot.
 */

import type { DomainEvent as WireDomainEvent } from "@bear-harness/protocol";
import { DomainEvent, EventPayloadSchemas } from "@bear-harness/protocol/schema";
import { asc, gt, max } from "drizzle-orm";
import type { AppDatabase } from "./database.js";
import { events } from "./schema.js";

const MAX_REPLAY_EVENTS = 100;

export type HostEvent = WireDomainEvent;
export type EventListener = (event: HostEvent) => void;

function validatePayload(kind: string, payload: unknown): unknown {
	const candidate = payload === undefined ? {} : payload;
	// Storage persists payloads as JSON (drizzle json mode), so validate the
	// exact JSON representation that will be written: undefined fields are
	// dropped and non-JSON values fail exactly like the insert would.
	let jsonValue: unknown;
	try {
		jsonValue = JSON.parse(JSON.stringify(candidate));
	} catch {
		throw new TypeError(`invalid domain event payload for ${kind}`);
	}
	const knownSchema = EventPayloadSchemas[kind as keyof typeof EventPayloadSchemas];
	if (!knownSchema) throw new TypeError(`unknown domain event ${kind}`);
	const result = knownSchema.safeParse(jsonValue);
	if (!result.success) {
		throw new TypeError(`invalid domain event payload for ${kind}`);
	}
	return result.data;
}

function parsePersistedEvent(row: unknown): HostEvent {
	const result = DomainEvent.safeParse(row);
	if (result.success) return result.data;
	const seq = typeof row === "object" && row !== null && "seq" in row ? String(row.seq) : "unknown";
	throw new Error(`malformed persisted event at sequence ${seq}`);
}

export class EventBus {
	private db: AppDatabase;
	private listeners = new Set<EventListener>();
	private seq = 0;
	private notifying = false;
	private readonly notifications: Array<{ event: HostEvent; listeners: EventListener[] }> = [];

	constructor(db: AppDatabase) {
		this.db = db;
		this.seq =
			db
				.select({ value: max(events.seq) })
				.from(events)
				.get()?.value ?? 0;
	}

	/** Publish an event: validate and write to DB, then notify listeners. */
	publish(kind: string, payload: unknown): HostEvent {
		const safePayload = validatePayload(kind, payload);
		const candidate = { seq: this.seq + 1, kind, payload: safePayload };
		const parsed = DomainEvent.safeParse(candidate);
		if (!parsed.success) throw new TypeError(`invalid domain event ${kind}`);
		this.db
			.insert(events)
			.values({ seq: parsed.data.seq, kind: parsed.data.kind, payload: parsed.data.payload })
			.run();
		this.seq = parsed.data.seq;
		// A listener may synchronously publish another event (e.g. a character
		// expression reacting to a Pi message). Finish delivering this event to
		// every subscriber before delivering any of its derived events.
		this.notifications.push({ event: parsed.data, listeners: [...this.listeners] });
		if (!this.notifying) {
			this.notifying = true;
			try {
				for (let index = 0; index < this.notifications.length; index++) {
					const notification = this.notifications[index];
					if (!notification) continue;
					for (const listener of notification.listeners) {
						if (!this.listeners.has(listener)) continue;
						try {
							listener(notification.event);
						} catch {
							/* isolate subscriber failures */
						}
					}
				}
			} finally {
				this.notifications.length = 0;
				this.notifying = false;
			}
		}
		return parsed.data;
	}

	/** Subscribe to events after a given sequence number. */
	subscribe(listener: EventListener, afterSeq?: number): () => void {
		this.listeners.add(listener);

		// Catch up in sequence order. A malformed row is a persisted gap:
		// surface it instead of silently delivering later rows as contiguous.
		try {
			if (afterSeq !== undefined && afterSeq > 0) {
				const rows = this.db
					.select({ seq: events.seq, kind: events.kind, payload: events.payload })
					.from(events)
					.where(gt(events.seq, afterSeq))
					.orderBy(asc(events.seq))
					.limit(MAX_REPLAY_EVENTS)
					.all();
				for (const row of rows) {
					const event = parsePersistedEvent(row);
					try {
						listener(event);
					} catch {
						/* listener error — swallow */
					}
				}
			}
		} catch (error) {
			this.listeners.delete(listener);
			throw error;
		}

		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Get the current event sequence number. */
	get currentSeq(): number {
		return this.seq;
	}

	after(afterSeq: number, limit = MAX_REPLAY_EVENTS): HostEvent[] {
		const rows = this.db
			.select({ seq: events.seq, kind: events.kind, payload: events.payload })
			.from(events)
			.where(gt(events.seq, afterSeq))
			.orderBy(asc(events.seq))
			.limit(Math.min(Math.max(0, limit), MAX_REPLAY_EVENTS))
			.all();
		return rows.map(parsePersistedEvent);
	}
}
