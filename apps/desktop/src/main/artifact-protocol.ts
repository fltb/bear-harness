/**
 * bear-artifact:// protocol — serving artifact blobs to the renderer.
 *
 * The renderer never touches the CAS directly: it only knows artifact ids
 * (from `artifact.list:v1`) and asks the host for a URL (`artifact.url:v1`,
 * which returns `bear-artifact://artifact/<id>` when this protocol is
 * registered, else ""). This module registers the custom scheme with minimal
 * privileges (`standard: false` — the URL cannot be navigated to or treated
 * as a page origin; `secure: true` + `supportFetchAPI` — fetch()-able from
 * the main frame; `stream: true` — blob bodies stream without buffering in
 * the network service).
 *
 * The handler is a pure function (`bearArtifactHandler`) so the serving
 * logic is unit-testable without Electron. Sender validation shares the IPC
 * router's registered main-frame identity policy: the request referrer must
 * equal the exact allowed URL of a currently registered window. Origin,
 * prefix, empty, and `about:client` representations are rejected.
 *
 * Responses are locked down: Content-Type from the artifact record,
 * Content-Length, `default-src 'none'` CSP, `Cache-Control: no-store` and
 * `nosniff` so a fetched blob is never interpreted as a page.
 */

import { protocol } from "electron";
import { isAllowedRendererReferrer, type WindowRegistration } from "./diagnostics/electron.js";

export const ARTIFACT_SCHEME = "bear-artifact";
export const ARTIFACT_PATH_PREFIX = "artifact";

/** The artifact-record projection the handler needs (subset of ArtifactRecord). */
export interface ArtifactLookup {
	/** Resolve an artifact record by id; null when unknown. */
	get(id: string): { mime: string; logicalName: string; bytes: number } | null;
	/** Read the CAS blob for an artifact id; null when the blob is missing. */
	readBlob(id: string): Buffer | null;
}

export interface ArtifactProtocolOptions extends ArtifactLookup {
	/**
	 * Current renderer registrations. A custom-protocol request has no IPC
	 * sender event, so Electron represents its renderer identity as the
	 * request referrer; it must match one registered window URL exactly.
	 */
	windowRegistry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>;
}

/** Must run before `app.whenReady()` (Electron requirement). */
export function registerArtifactSchemePrivileges(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: ARTIFACT_SCHEME,
			privileges: {
				standard: false,
				secure: true,
				supportFetchAPI: true,
				stream: true,
			},
		},
	]);
}

/** Result of parsing a bear-artifact URL. */
export type ArtifactUrlParse =
	| { kind: "ok"; id: string }
	| { kind: "invalid" }
	| { kind: "unknown" };

/**
 * Parse a bear-artifact URL. `ok` carries the artifact id; `invalid` means
 * the artifact endpoint is present but the id is malformed (→ 404);
 * `unknown` means the URL is not the artifact endpoint at all — with
 * `standard: false` the scheme is not hierarchical, so only the exact
 * `bear-artifact://artifact/<id>` form is accepted (→ 403).
 */
export function parseArtifactUrl(rawUrl: string): ArtifactUrlParse {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { kind: "unknown" };
	}
	if (url.protocol !== `${ARTIFACT_SCHEME}:`) return { kind: "unknown" };
	if (url.host !== ARTIFACT_PATH_PREFIX) return { kind: "unknown" };
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length !== 1 || !segments[0]) return { kind: "unknown" };
	try {
		const id = decodeURIComponent(segments[0]);
		return id ? { kind: "ok", id } : { kind: "invalid" };
	} catch {
		return { kind: "invalid" }; // malformed percent-encoding → invalid id
	}
}

function plain(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

/**
 * Pure protocol handler. Returns a locked-down Response for a valid artifact
 * request, 403 for disallowed senders / unknown scheme content, 404 for
 * unknown or invalid artifact ids.
 */
export function bearArtifactHandler(options: ArtifactProtocolOptions) {
	const { get, readBlob, windowRegistry } = options;
	return async (request: Request): Promise<Response> => {
		if (!isAllowedRendererReferrer(request.referrer, windowRegistry)) {
			return plain(403, "forbidden");
		}
		const parsed = parseArtifactUrl(request.url);
		if (parsed.kind === "unknown") {
			// Scheme content that is not the artifact endpoint.
			return plain(403, "forbidden");
		}
		if (parsed.kind === "invalid") {
			return plain(404, "not found");
		}
		const artifact = get(parsed.id);
		const blob = artifact ? readBlob(parsed.id) : null;
		if (!artifact || !blob) {
			return plain(404, "not found");
		}
		return new Response(blob, {
			status: 200,
			headers: {
				"Content-Type": artifact.mime || "application/octet-stream",
				"Content-Length": String(blob.byteLength),
				"Content-Security-Policy": "default-src 'none'",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	};
}

/** Register the handler for the scheme (after `app.whenReady()`). */
export function registerArtifactProtocol(options: ArtifactProtocolOptions): void {
	protocol.handle(ARTIFACT_SCHEME, bearArtifactHandler(options));
}
