import type { AnyRpcEndpoint, EnvelopeOf, RequestOf } from "@bear-harness/protocol";
import { InvalidationBatch, LivePushBatch, RPC, RpcResponse } from "@bear-harness/protocol/schema";

/**
 * Host-owned transport boundary for RPC calls.
 *
 * `invoke` resolves to a protocol `RpcEnvelope` for domain/RPC outcomes.
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
	listenInvalidations?(
		receive: (batch: unknown) => void,
		fail: (error: unknown) => void,
	): () => void;
	/** Resolves only after the transient live stream is connected. */
	subscribeLive?(signal: AbortSignal): Promise<AsyncIterable<unknown>>;
	invoke<E extends AnyRpcEndpoint>(endpoint: E, request: RequestOf<E>): Promise<unknown>;
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
	invalidations: {
		stream(
			signal: AbortSignal,
		): AsyncIterable<ReturnType<typeof InvalidationBatch.parse>["notices"][number]>;
	};
	live: {
		subscribe(
			signal: AbortSignal,
		): Promise<AsyncIterable<ReturnType<typeof LivePushBatch.parse>["events"][number]>>;
	};
};

async function subscribeLive(
	transport: HostTransport,
	signal: AbortSignal,
): Promise<AsyncIterable<ReturnType<typeof LivePushBatch.parse>["events"][number]>> {
	if (!transport.subscribeLive) throw new Error("Host transport does not support live push");
	const batches = await transport.subscribeLive(signal);
	return {
		async *[Symbol.asyncIterator]() {
			for await (const batch of batches) {
				for (const event of LivePushBatch.parse(batch).events) yield event;
			}
		},
	};
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
							const response = await transport.invoke(value, parsedRequest as never);
							return RpcResponse(value.response).parse(response);
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
		live: Object.freeze({
			subscribe: (signal: AbortSignal) => subscribeLive(transport, signal),
		}),
		invalidations: Object.freeze({
			async *stream(signal: AbortSignal) {
				if (signal.aborted) return;
				if (!transport.listenInvalidations)
					throw new Error("Host transport does not support invalidation push");
				const queue: unknown[] = [];
				let error: unknown;
				let failed = false;
				let wake: (() => void) | undefined;
				const abort = () => wake?.();
				signal.addEventListener("abort", abort, { once: true });
				let stop: (() => void) | undefined;
				try {
					stop = transport.listenInvalidations(
						(batch) => {
							if (failed || signal.aborted) return;
							if (queue.length >= 10000) {
								failed = true;
								error = new Error("Host invalidation consumer overflow");
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
							for (const notice of InvalidationBatch.parse(queue.shift()).notices) yield notice;
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
