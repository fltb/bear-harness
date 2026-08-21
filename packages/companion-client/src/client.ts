import type { AnyRpcEndpoint, EnvelopeOf, RequestOf } from "@bear-harness/protocol";
import { IpcResponse, RPC } from "@bear-harness/protocol/schema";

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
export type CompanionClient = ClientNode<typeof RPC>;

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
							return IpcResponse(value.response).parse(response);
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
	return buildClientNode(RPC, transport) as CompanionClient;
}
