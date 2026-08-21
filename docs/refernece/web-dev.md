# WebDev module reference

`apps/web-dev` is the browser-based development application. It runs the same host-runtime-facing application contracts as the desktop client, but puts the Host in a Node process and serves the Solid renderer through an Rsbuild development server. It is a local development and E2E harness, not a production web deployment.

## Responsibility and boundaries

The module has two cooperating processes:

- **Loopback Host** — [`server/index.ts`](../../apps/web-dev/server/index.ts) creates the host runtime, owns the data directory and credential vault, and exposes the bootstrap, RPC, debug, and renderer-diagnostics HTTP routes.
- **Browser UI/proxy** — [`src/index.tsx`](../../apps/web-dev/src/index.tsx) bootstraps the renderer and creates the HTTP `HostTransport`. Rsbuild serves the compiled/dev assets and proxies Host paths to the loopback Host; the proxy is configured in [`rsbuild.config.ts`](../../apps/web-dev/rsbuild.config.ts).

The package is private and ESM (`type: module`). Its runtime dependencies include the companion client/UI, Host runtime, product configuration, i18n, and protocol packages. The development toolchain is Rsbuild/Solid plus Playwright ([`package.json`](../../apps/web-dev/package.json)).

This arrangement differs from Electron in process shape and delivery, not in the core Host contract: WebDev has a browser origin and a separately started Node Host, while the desktop variant supplies its own packaged application shell. WebDev's data-directory tests explicitly preserve the platform directory convention used by Electron's `userData`; an explicit E2E directory is the isolation escape hatch ([`server/data-directory.spec.ts`](../../apps/web-dev/server/data-directory.spec.ts)). Do not interpret the browser server as a deployable internet-facing service.

## Public entrypoints and API

### Package commands

From the repository root:

```sh
npm run dev --workspace @bear-harness/web-dev
npm run build --workspace @bear-harness/web-dev
npm run typecheck --workspace @bear-harness/web-dev
npm run test:unit --workspace @bear-harness/web-dev
npm run test:e2e:web
```

The package scripts are the source of truth for the supported entrypoints: `dev` runs `scripts/dev.mjs`, `build` runs `scripts/build.mjs`, `typecheck` checks separate server and renderer projects, `test:unit` runs the data-directory unit file, and `test:e2e` runs Playwright ([`package.json`](../../apps/web-dev/package.json)).

### HTTP routes

The Host accepts only the loopback address `127.0.0.1` on `BEAR_WEB_DEV_HOST_PORT` (default `3201`). `BEAR_WEB_DEV_HOST` and `BEAR_WEB_DEV_LISTEN` are accepted only when they are exactly `127.0.0.1`; `BEAR_WEB_DEV_PUBLIC=1` (or `true`/`yes`) and production intent (`NODE_ENV=production` or `BEAR_WEB_DEV_PRODUCTION=1`) fail startup. The browser normally talks to the UI origin on `BEAR_WEB_DEV_PORT` (default `3200`); Rsbuild proxies the paths below to the Host.

| Route | Auth | Behavior |
| --- | --- | --- |
| `GET /bootstrap` | None | Returns only `{ product, token, debugEnabled }`; the token is generated once per Host process. |
| `POST /rpc/<channel>` | `x-bear-web-dev-token` required | JSON-decodes the body and dispatches the decoded channel to `runtime.dispatch`. `character.import:v1` receives a 36 MiB body allowance; other routes use the 64 KiB default. Dispatch outcomes — success and domain failure — resolve HTTP `200` with the original validated envelope. |
| `GET /debug/channels` | Token required; debug mode required | Returns the sorted keys of `REQUEST_SCHEMAS`. |
| `POST /diagnostics/renderer-fault` | Token required | Reads a fault payload and writes it to stderr with a WebDev prefix; responds `204` for a valid payload. |
| Any other route | Token required (except bootstrap) | Returns a safe JSON `unknown_route` `404`; missing or invalid tokens are rejected with safe JSON `unauthorized` `401` before route matching. |

Only pre-dispatch failures use non-2xx HTTP statuses with safe JSON `{ ok: false, error: { kind, reason } }` envelopes: `401/unauthorized`, `413/body_too_large`, `400/malformed_json`, `400/invalid_request` (channel decoding), `404/unknown_channel`, `404/unknown_route`, and `500/internal_error` for thrown transport/protocol failures. Once a request reaches `runtime.dispatch`, both success and every domain failure (including schema rejection and `conflict`/`not_found`/`unavailable`/`internal` kinds) resolve HTTP `200` with the original envelope, preserving the exact protocol reason — the companion client distinguishes an RPC failure from a transport rejection at its own boundary. HTTP error reasons are fixed categories and never include exception text, paths, credentials, or provider payloads.

The route implementation is in [`server/index.ts`](../../apps/web-dev/server/index.ts). The RPC channel is URI-decoded from the path. The renderer transport in [`src/http-client.ts`](../../apps/web-dev/src/http-client.ts) URI-encodes the channel, sends JSON, attaches the token, and returns the JSON response. Relative URLs are intentional: browser requests reach the UI origin first and are then proxied to the loopback Host.

## Architecture and data/control flow

```mermaid
flowchart LR
  B[Browser / Solid UI] -->|GET /bootstrap| P[Rsbuild proxy :3200]
  P -->|proxy /bootstrap /rpc /debug /diagnostics| H[Node Host :3201]
  H --> R[createHostRuntime]
  R --> D[(platform or scoped data directory)]
  R --> V[Web credential vault]
  B -->|POST /rpc/channel + bearer token| P
  H -->|dispatch channel| R
  E[Playwright] -->|UI + request APIs| P
  E --> Q[deterministic rule provider :3211]
  Q -->|OpenAI-compatible chat/SSE| R
```

Before runtime setup, [`server/index.ts`](../../apps/web-dev/server/index.ts) validates the requested listen address and deployment intent, refusing anything other than `127.0.0.1` or any production/public flag. It then resolves repository root, chooses the data directory, creates it with mode `0700`, generates a 32-byte random hexadecimal token, constructs `createHostRuntime` with the character root and product config, and calls `runtime.start()`. Provider environment overrides/custom setup are dispatched through the same RPC contracts before `server.listen` binds the loopback port.

Renderer startup uses top-level `await`: it requires `#root`, loads and runtime-validates bootstrap (including every required [`ProductConfig`](../../packages/product-config/src/index.ts) field, the non-empty token, and the boolean debug flag), builds the authenticated HTTP transport and companion client, installs renderer-fault reporting, and renders `CompanionApp`. The debug panel is rendered only when `debugEnabled` is true ([`src/index.tsx`](../../apps/web-dev/src/index.tsx)).

## Bootstrap and security model

The token is an in-memory per-Host-process bearer credential generated with `randomBytes(32)` and returned by the unauthenticated bootstrap route. Bootstrap is intentionally unauthenticated so a fresh browser can learn the token; all Host operations after that check the exact `x-bear-web-dev-token` value before route dispatch. Responses set `cache-control: no-store` and JSON content type.

The security boundary is therefore **loopback binding plus possession of the bootstrap token**, not user authentication. Any local process able to reach the loopback port can request `/bootstrap` and then invoke the available RPC surface. The Host does not add CORS, account authentication, TLS, rate limiting, or CSRF protection. This is acceptable only for local development/E2E: the server refuses non-loopback listen overrides and production/public intent at startup, and maintainers MUST NOT expose the Host, UI proxy, or generated assets as an internet-facing service.

The Host constructs [`createWebCredentialVault`](../../apps/web-dev/server/credential-vault.ts) over the selected data directory. The vault uses an AES-256-GCM key, stores its generated key as `security/web-vault.key` with restrictive file mode, or derives a key from `BEAR_WEB_DEV_MASTER_KEY`; it reports machine-level security. This protects persisted credential blobs at rest, but does not protect an RPC caller that has obtained the loopback token. The debug panel's API-key action passes `sessionOnly: true`, clears its input after success, and uses the same authenticated transport ([`src/DebugPanel.tsx`](../../apps/web-dev/src/DebugPanel.tsx)).

## HTTP RPC transport and error behavior

`createHttpTransport` maps a `HostTransport.invoke` call to `POST /rpc/<encoded channel>`. It sends `content-type: application/json`, the bearer token header, and `JSON.stringify(params)`. An HTTP failure rejects with a typed `WebDevHttpError` carrying the operation and status; network and JSON parsing rejections are intentionally passed through unchanged. Successful responses remain unvalidated transport data so the companion client can validate each endpoint's full response envelope at its boundary ([`src/http-client.ts`](../../apps/web-dev/src/http-client.ts)). Bootstrap and debug-channel payloads are validated at their own HTTP boundary; raw debug RPC invocation additionally validates its endpoint envelope before displaying it ([`src/DebugPanel.tsx`](../../apps/web-dev/src/DebugPanel.tsx)).

The server limits request-body accumulation before JSON parsing and maps each pre-dispatch failure class to a fixed status/category: `413/body_too_large`, `400/malformed_json`, `400/invalid_request` (channel decoding), `404/unknown_channel`, `404/unknown_route`, `401/unauthorized`, and `500/internal_error` for thrown transport/protocol failures. Dispatch results are not HTTP-mapped: success and domain failure both resolve HTTP `200` with the original validated envelope so the exact protocol `reason` (for example `roleplay_event_branch_not_canonical`) survives the transport. Every non-2xx HTTP error is a safe JSON envelope with a static reason; exception text and request contents are not returned.

Renderer faults are intentionally lossy local diagnostics: `installRendererFaultReporting` posts the serialized fault fire-and-forget with the token, while the client does not await, retry, or surface the fetch result. The Host reduces each payload to one stderr line and retains no durable or queryable diagnostic state; do not treat this route as crash reporting or telemetry.

## Debug surface

The dev launcher defaults `BEAR_WEB_DEV_DEBUG` to `1` unless the caller supplied a value; the Host enables debug routes only when the value is exactly `"1"`. In debug mode, `WebDevDebugPanel` adds a `Web Dev` toggle. Opening it lazily loads and validates the registered channel list. Raw invocation parses the editor JSON, finds the channel in `CHANNEL_CONTRACTS`, validates the request schema and returned endpoint envelope, invokes through the authenticated transport, and pretty-prints the validated result. The panel also lists providers through the companion client and can set a provider API key for the session ([`src/DebugPanel.tsx`](../../apps/web-dev/src/DebugPanel.tsx)).

The debug channel list exposes every key in `REQUEST_SCHEMAS`; it is not an allowlist of safe read-only operations. The panel's schema lookup prevents unknown channels from being invoked through its UI, but any caller with the token can still submit arbitrary `/rpc` paths and is subject to Host/runtime validation. Keep debug mode local and treat provider credentials and returned data as sensitive.

## Data-directory and process isolation

`server/index.ts` calls `webDevDataDirectory(productConfig.dataDirectoryName)` and creates the result recursively with `0700`. With no override, the helper uses the platform location (`~/Library/Application Support/<name>` on macOS, `%APPDATA%/<name>` on Windows, and `$XDG_CONFIG_HOME` or `~/.config` on Linux), matching the desktop convention. With `BEAR_WEB_DEV_DATA_DIR`, the base is the explicit resolved path.

`scripts/dev.mjs` adds a second isolation layer when that override is present: it passes `BEAR_WEB_DEV_DATA_SCOPE=<launcher pid>`, and `webDevDataDirectory` resolves the final path as `<override>/.process-<scope>`. Playwright sets `BEAR_WEB_DEV_DATA_DIR` to `test-results/web-dev-data-<runner pid>`, so each dev launcher gets a distinct child directory. This process-scoped behavior addresses the readiness/state-isolation failure mode where an E2E run could reuse state from another Host process. The direct unit tests cover both distinct scopes and platform-directory behavior.

Process-scoped directories are not removed by the launcher or Playwright config: repeated E2E/dev runs can leave stale credentials and application state under `test-results`, and failure artifacts are intentionally retained for diagnosis. Normal manual development without an explicit `BEAR_WEB_DEV_DATA_DIR` override intentionally reuses the platform data directory, so a browser session can observe state created by Electron or a previous WebDev run. Set `BEAR_WEB_DEV_DATA_DIR` when an isolated manual session is required.

## Dev and build lifecycle

### `npm run dev`

[`scripts/dev.mjs`](../../apps/web-dev/scripts/dev.mjs) first loads the repository `.env` when present, then synchronously builds `product-config`, `protocol`, `companion-client`, `host-runtime`, and `companion-ui`. A failed dependency build exits immediately.

It selects an available loopback Host port starting at `3201`, then a distinct UI port starting at `3200`, probing at most 20 consecutive ports and reserving the Host port while selecting the UI port. It starts `server/index.ts` with the selected ports (and optional data scope), waits up to 30 seconds for a valid JSON `/bootstrap`, then starts `npx --no-install rsbuild dev`. A second bootstrap wait verifies that the UI proxy is serving the Host response before printing `web-dev UI ready: http://127.0.0.1:<uiPort>`.

The launcher owns both children. An unexpected child exit causes both to receive `SIGTERM`; launcher `SIGINT`/`SIGTERM` follows the same shutdown path. The readiness check verifies status/content type and that the payload contains a string token and object product, rather than merely checking that a TCP port is open.

The port probe is a check-then-bind sequence, so another process can claim a probed port before the child binds. The Host does not use `strictPort`/retry handling in this file, while Rsbuild is configured with `strictPort: true`; a race or provider port conflict can therefore fail startup after the probe. Treat selected ports as ephemeral and use the readiness output/configured environment, not hard-coded defaults.

### `npm run build`

[`scripts/build.mjs`](../../apps/web-dev/scripts/build.mjs) rebuilds the same five workspace dependencies and then runs `rsbuild build`, writing the renderer output under `dist`. This builds browser assets; it does not package a server or create a production web service. `server/index.ts` remains a Node development Host entrypoint and must be run with the repository's expected Node/TypeScript setup.

## Deterministic provider and Playwright E2E

[`playwright.config.ts`](../../apps/web-dev/playwright.config.ts) loads the repository `.env` if present, derives WebDev, Host, and provider ports from `BEAR_E2E_WEB_PORT` (`3200`), `BEAR_E2E_HOST_PORT` (`3201`), and `BEAR_E2E_PROVIDER_PORT` (`3211`), and targets `http://127.0.0.1:<webPort>`. It runs one worker, uses a 30-second test timeout and web-server startup timeout, forbids focused tests, disables retries, and writes artifacts under `test-results/web-dev`.

Playwright starts two non-reused servers:

1. `npm run dev --workspace @bear-harness/web-dev`, with debug enabled, process-isolated data, and the `BEAR_CUSTOM_PROVIDER_ID`, `BEAR_CUSTOM_PROVIDER_NAME`, `BEAR_CUSTOM_BASE_URL`, `BEAR_CUSTOM_MODEL_ID`, and `BEAR_CUSTOM_API_KEY` variables cleared. Clearing those variables prevents a developer's `.env` custom provider from changing the deterministic test contract; other provider override/credential variables are not cleared by this configuration.
2. `node e2e/rule-provider-server.ts`, an OpenAI-compatible loopback server whose health endpoint gates readiness.

The rule provider returns stable marker text for the E2E prompts, recognizes image/tool/memory/context scenarios, records prompts and tool calls, and supports both regular JSON and streamed SSE chat completions. Its `/trace/tools` and `/trace/prompts` endpoints let tests inspect what the Host sent. E2E helpers configure the provider through authenticated RPC (`provider.customUpsert`, `provider.setApiKey`, `model.enable`, and reply defaults), complete onboarding, and then reload the UI ([`e2e/helpers.ts`](../../apps/web-dev/e2e/helpers.ts)). This makes browser journeys deterministic without requiring a live model or provider credential.

The provider server also binds loopback, but unlike WebDev's launcher it uses a fixed configured port and does not probe alternatives. A stale process or occupied port produces a readiness failure rather than an automatic relocation. Its trace endpoints have no application token because they are test-only loopback endpoints; do not run this harness on a reachable interface.

## Lifecycle and extension points

- Add a Host capability by registering its protocol request schema/runtime handler in the protocol/Host-runtime packages, after which it appears in `/debug/channels` and can be selected by the debug panel. The debug panel imports `CHANNEL_CONTRACTS` from the shared protocol registry, so adding the endpoint to that registry makes typed debug invocation available; there is no separate renderer channel map.
- Add renderer behavior in `src/index.tsx` or the companion UI; preserve bootstrap-before-render so the product config and token exist before constructing the client.
- Add a development-only diagnostic route in `server/index.ts` only behind the token check, and add its path to Rsbuild's proxy map if the browser must call it.
- Add deterministic E2E behavior to the rule provider and tests rather than depending on a live external model. Keep provider setup explicit and clear custom environment variables in Playwright.
- Keep all new local-only endpoints loopback-bound and document whether their payloads can contain credentials, prompts, or user data.

## Known issues / findings

1. **Local bearer-token model is intentionally broad but strictly local.** `/bootstrap` gives the token to any loopback client, and possession authorizes all RPC/debug calls. There is no user identity or capability split. The server rejects non-loopback listen overrides and production/public intent, so this remains a development-only boundary rather than production authentication.
2. **Pre-dispatch failures are categorized at the HTTP boundary; domain failures are not.** Body limits, malformed JSON, channel decoding, unknown route/channel, authorization failures, and thrown internal/protocol failures have distinct non-2xx status/category pairs with fixed reasons. Domain/RPC failures returned by `runtime.dispatch` resolve HTTP `200` with the original validated envelope (exact `reason` preserved) so the companion client can tell an RPC failure from a transport rejection; no exception details or request contents are returned.
3. **Bootstrap/transport boundaries are validated.** `loadBootstrap` rejects malformed ProductConfig-compatible payloads, empty tokens, and non-boolean debug flags before renderer startup. HTTP failures use `WebDevHttpError`, while network and JSON parsing rejections pass through; successful RPC envelope validation remains at the companion client boundary and raw debug invocation validates its own envelope.
4. **Port selection has a race.** `availablePort` probes before child startup. Another process can bind between those operations; Rsbuild's strict UI port then fails rather than retrying. The deterministic provider has the additional fixed-port collision risk noted above.
5. **E2E data isolation is addressed but not cleaned.** Supplying `BEAR_WEB_DEV_DATA_DIR` now scopes state by launcher process, preventing concurrent runs from sharing state. Neither launcher nor Playwright removes old `.process-*` directories, so stale data accumulates.
6. **Manual WebDev state is intentionally persistent.** Without `BEAR_WEB_DEV_DATA_DIR`, WebDev uses the platform data path shared with prior WebDev/Electron sessions. Set that override when an isolated manual session is required; process-scoped E2E data remains under `test-results` for deliberate failure diagnosis.
7. **Diagnostics are intentionally lossy and local.** Renderer-fault reporting is fire-and-forget from the browser, and the Host reduces each payload to one stderr line without durable or queryable state. It is useful for local diagnosis, not crash reporting or telemetry.
8. **Production deployment is prohibited.** `build` produces browser assets after rebuilding workspace packages; it does not bundle, supervise, authenticate, or deploy `server/index.ts`. The Host refuses production/public-listen intent and must never be exposed directly, through the UI proxy, or through a forwarding/shared proxy.
