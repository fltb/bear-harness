import type { AnyRpcEndpoint, EnvelopeOf, RequestOf, SyncRevision } from "@bear-harness/protocol";
import {
	EventSubscribeResponse,
	IpcResponse,
	PiEventSubscribeResponse,
	RPC,
} from "@bear-harness/protocol/schema";

/**
 * Host-owned transport boundary for RPC calls.
 *
 * `invoke` resolves to a protocol `IpcEnvelope` for domain/RPC outcomes.
 * Transport failures (for example a disconnected link, timeout, or
 * cancellation) reject the returned promise and MUST NOT be fabricated as an
 * RPC failure envelope.
 *
 * Timeout and cancellation policy belongs to each transport implementation;
 * this client adds neither policy nor retries. In particular, transports MUST
 * NOT retry mutations unless an endpoint-specific idempotency contract exists.
 */
export interface HostTransport {
	/** One persistent server-push subscription; no periodic requests. */
	listen?(
		afterSeq: number,
		receive: (batch: unknown) => void,
		fail: (error: unknown) => void,
	): () => void;
	/** Transient native Pi events; there is deliberately no replay cursor. */
	listenPi?(receive: (batch: unknown) => void, fail: (error: unknown) => void): () => void;
	invoke<E extends AnyRpcEndpoint>(endpoint: E, request: RequestOf<E>): Promise<unknown>;
}

const responseRevisions = new WeakMap<object, SyncRevision>();
const mutationRevisions = new WeakSet<SyncRevision>();
const revisionRequests = new WeakMap<SyncRevision, number>();
let nextRequest = 0;
export function responseRequestSequence(value: unknown): number | undefined {
	const sync = responseRevision(value);
	return sync ? revisionRequests.get(sync) : undefined;
}
/** Metadata stays outside DTOs; projections retain the provenance of their read. */
export function responseRevision(value: unknown): SyncRevision | undefined {
	return value !== null && typeof value === "object" ? responseRevisions.get(value) : undefined;
}

/** Commands carry a completion watermark, not a consistent read projection. */
export function isMutationResponse(value: unknown): boolean {
	const revision = responseRevision(value);
	return revision !== undefined && mutationRevisions.has(revision);
}

export function withResponseRevision<T>(value: T, revision: SyncRevision | undefined): T {
	if (!revision) return value;
	const visit = (item: unknown): void => {
		if (item === null || typeof item !== "object" || responseRevisions.get(item) === revision)
			return;
		responseRevisions.set(item, revision);
		for (const child of Object.values(item)) visit(child);
	};
	visit(value);
	return value;
}

type RpcMethod<E extends AnyRpcEndpoint> =
	Record<string, never> extends RequestOf<E>
		? (request?: RequestOf<E>) => Promise<EnvelopeOf<E>>
		: (request: RequestOf<E>) => Promise<EnvelopeOf<E>>;

type ClientNode<Node> = {
	readonly [Key in keyof Node]: Node[Key] extends AnyRpcEndpoint
		? RpcMethod<Node[Key]>
		: ClientNode<Node[Key]>;
};

/**
 * Complete client facade; method input/output changes follow their Zod
 * schemas automatically. Methods resolve both successful and RPC/domain
 * failure envelopes. A rejected method call is a transport failure; this
 * facade does not retry or convert it into an envelope.
 */
export type CompanionClient = ClientNode<typeof RPC> & {
	events: ClientNode<typeof RPC.events> & {
		stream(
			afterSeq: number,
			signal: AbortSignal,
		): AsyncIterable<ReturnType<typeof EventSubscribeResponse.parse>["events"]>;
	};
	pi: {
		stream(
			signal: AbortSignal,
		): AsyncIterable<ReturnType<typeof PiEventSubscribeResponse.parse>["events"][number]>;
	};
};

async function* transientPiStream(
	transport: HostTransport,
	signal: AbortSignal,
): AsyncIterable<ReturnType<typeof PiEventSubscribeResponse.parse>["events"][number]> {
	if (signal.aborted) return;
	if (!transport.listenPi) throw new Error("Host transport does not support Pi event push");
	const queue: unknown[] = [];
	let error: unknown;
	let failed = false;
	let wake: (() => void) | undefined;
	const abort = () => wake?.();
	signal.addEventListener("abort", abort, { once: true });
	let stop: (() => void) | undefined;
	try {
		stop = transport.listenPi(
			(batch) => {
				if (failed || signal.aborted) return;
				if (queue.length >= 1000) {
					failed = true;
					error = new Error("Pi event consumer overflow");
				} else queue.push(batch);
				wake?.();
			},
			(cause) => {
				failed = true;
				error = cause;
				wake?.();
			},
		);
		while (!signal.aborted) {
			if (queue.length) {
				for (const event of PiEventSubscribeResponse.parse(queue.shift()).events) yield event;
				continue;
			}
			if (failed) throw error;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	} finally {
		stop?.();
		signal.removeEventListener("abort", abort);
	}
}

function isEndpoint(value: unknown): value is AnyRpcEndpoint {
	return typeof value === "object" && value !== null && "kind" in value && value.kind === "rpc";
}

function buildClientNode(node: object, transport: HostTransport): object {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(node).map(([key, value]) => [
				key,
				isEndpoint(value)
					? async (request: unknown = {}) => {
							const parsedRequest = value.request.parse(request);
							const requestSequence = ++nextRequest;
							const response = await transport.invoke(value, parsedRequest as never);
							const envelope = IpcResponse(value.response).parse(response);
							if (envelope.ok) {
								if (envelope.sync) revisionRequests.set(envelope.sync, requestSequence);
								if (envelope.sync && value.operation === "mutation")
									mutationRevisions.add(envelope.sync);
								withResponseRevision(envelope.data, envelope.sync);
							}
							return envelope;
						}
					: buildClientNode(value as object, transport),
			]),
		),
	);
}

/**
 * Build the facade mechanically from the shared RPC endpoint tree.
 *
 * Request and response validation happen at this boundary. The transport
 * remains responsible for timeout/cancellation behavior; errors it rejects
 * with pass through unchanged, and no automatic retries are performed.
 */
export function createCompanionClient(transport: HostTransport): CompanionClient {
	const rpc = buildClientNode(RPC, transport) as ClientNode<typeof RPC>;
	return Object.freeze({
		...rpc,
		pi: Object.freeze({
			stream: (signal: AbortSignal) => transientPiStream(transport, signal),
		}),
		events: Object.freeze({
			...rpc.events,
			async *stream(afterSeq: number, signal: AbortSignal) {
				if (signal.aborted) return;
				if (!transport.listen) throw new Error("Host transport does not support event push");
				const queue: unknown[] = [];
				let error: unknown;
				let failed = false;
				let wake: (() => void) | undefined;
				const abort = () => wake?.();
				signal.addEventListener("abort", abort, { once: true });
				let stop: (() => void) | undefined;
				try {
					stop = transport.listen(
						afterSeq,
						(batch) => {
							if (failed || signal.aborted) return;
							if (queue.length >= 10000) {
								failed = true;
								error = new Error("Host event consumer overflow");
							} else queue.push(batch);
							wake?.();
						},
						(cause) => {
							failed = true;
							error = cause;
							wake?.();
						},
					);
					while (!signal.aborted) {
						if (queue.length) {
							yield EventSubscribeResponse.parse(queue.shift()).events;
							continue;
						}
						if (failed) throw error;
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				} finally {
					stop?.();
					signal.removeEventListener("abort", abort);
				}
			},
		}),
	});
}
