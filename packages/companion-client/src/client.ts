import type { AnyRpcEndpoint, EnvelopeOf, RequestOf } from "@bear-harness/protocol";
import { IpcResponse, RPC } from "@bear-harness/protocol/schema";

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

/** Complete client facade; method input/output changes follow their Zod schemas automatically. */
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

/** Build the facade mechanically from the same endpoint tree used by Host. */
export function createCompanionClient(transport: HostTransport): CompanionClient {
	return buildClientNode(RPC, transport) as CompanionClient;
}
