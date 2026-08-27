/**
 * Neutral companion client for the Bear Harness host link.
 *
 * `createCompanionClient(transport)` mirrors the shared RPC registry and
 * validates requests and resolved response envelopes at the client boundary.
 * RPC/domain failures resolve as `{ ok: false, error }`; failures to reach the
 * Host reject as transport errors. Timeout, cancellation, and retry policy are
 * owned by the supplied transport, and this package never retries calls (in
 * particular, mutations without an idempotency contract).
 *
 * This package has no Electron, DOM, Solid, or Node imports.
 */

export type {
	IpcError,
	MemoryCaptureCreatedBy,
	MemoryCaptureRequest,
	MemoryCaptureResponse,
	MemoryEditRequest,
	MemoryForgetRequest,
	ProviderCustomUpsertRequest,
	ProviderImportPiConfigRequest,
	ProviderImportPiConfigResponse,
	ProviderInfo,
	ProviderListRequest,
	ProviderListResponse,
	ProviderLoginAnswerRequest,
	ProviderLoginCancelRequest,
	ProviderLoginCancelResponse,
	ProviderLoginRequest,
	ProviderLoginResponse,
	ProviderLoginStatusRequest,
	ProviderLogoutRequest,
	ProviderOverrideBaseUrlRequest,
	ProviderRemoveRequest,
	ProviderSetApiKeyRequest,
} from "@bear-harness/protocol";
export {
	type CompanionClient,
	createCompanionClient,
	type HostTransport,
	isMutationResponse,
	responseRequestSequence,
	responseRevision,
	withResponseRevision,
} from "./client.js";
export { unwrap } from "./unwrap.js";
