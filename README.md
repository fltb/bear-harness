# Bear Harness

Bear Harness is a roleplay-first local Companion for Cyber Bear: a desktop application in which a character, an ongoing relationship, and clearly bounded real-world work share one Host-managed runtime. The default character is 极昼 (Jizhou). Conversation is the primary entry point; file work, research, generated documents, and other actions are explicit, reviewable work rather than a separate agent console.

The repository is an npm workspaces monorepo. The Electron desktop app is the production shell. WebDev is a local browser development and end-to-end harness, not a public web deployment.

## What it does

- Runs a Host-owned conversation, onboarding, character, scene, roleplay, and presentation model.
- Loads validated character packages containing identity, style, canon, scenes, expressions, media, roleplay declarations, skills, and optional plugins.
- Supports conversation branches and message editing, regeneration, version selection, continuation, correction, and abort.
- Provides user-controlled relationship memory, scoped memory search/capture/edit/forget/exclude, and assistant memory candidates that require a user decision.
- Provides story and canon archives, including source ingestion and search, and exposes revision-aware character-package draft APIs; the in-app package workshop is currently disabled.
- Configures providers and models, including explicit image-model routing when a reply model cannot read images.
- Turns approved work proposals into tracked runs with permission requests, steering, interruption/resumption, cancellation, and content-addressed artifacts. Results are linked to the triggering message and can be previewed in the right-hand ResultSpace.
- Provides event/snapshot projections, audit records, diagnostics, and platform-specific credential boundaries.
- Integrates the host-neutral Tdai memory core: L0 capture, L1 extraction, L2 scene processing, L3 persona processing, and keyword/vector/hybrid recall when configured.

The product deliberately keeps character-package declarations, relationship memory, conversation state, and real-world work facts as separate ownership boundaries. Character copy comes from the package; product interface copy comes from the i18n catalogs; Host state and protocol validation remain authoritative.

## Architecture

```text
Electron desktop shell ─┐
                        ├─ transport ─ companion-client ─ protocol/schema
WebDev browser + Node Host ┘                         │
                                                     ▼
                                           Host Runtime + SQLite/EventBus
                                             │       │        │
                                   character packages  │   commissions/artifacts
                                             │       │
                                         Tdai memory  │  providers/models/credentials
                                                     ▼
                                              companion-ui (SolidJS)
```

- **Host Runtime** owns canonical persistence, RPC dispatch, character validation, conversation turns, providers/models, memory integration, work execution, artifacts, events, and audit projections.
- **Protocol and schema** define versioned RPC channels and strict request/response/domain validators. `companion-client` derives a typed client from that registry and leaves transport concerns to Electron IPC or WebDev HTTP.
- **Companion UI** is a transport-independent SolidJS renderer. It receives `ProductConfig` and a client; it does not read host files or create its own authority.
- **Desktop** supplies Electron isolation, preload IPC, credential encryption, diagnostics, the artifact scheme, and packaging.
- **WebDev** starts the same Host contract in Node and proxies a browser renderer over loopback with a per-process bearer token. Its boundary is intended for local development and E2E only.

## Workspace map

| Workspace | Role | Reference |
|---|---|---|
| `@bear-harness/schema` | Shared Zod namespace, schema constraint/inference helpers, and JSON Schema conversion. | [`schema`](docs/refernece/protocol-schema.md#shared-schema-package) |
| `@bear-harness/protocol` | Runtime RPC registry, versioned channels, domain validators, envelopes, events, snapshots, and type facade. | [`protocol`](docs/refernece/protocol-schema.md) |
| `@bear-harness/companion-client` | Transport-neutral typed client that validates requests and response envelopes. | [`companion-client`](docs/refernece/companion-client.md) |
| `@bear-harness/companion-ui` | SolidJS application shell, store, conversation UI, settings, onboarding, work timeline, and ResultSpace. | [`companion-ui`](docs/refernece/companion-ui.md) |
| `@bear-harness/host-runtime` | Instance-scoped Host: SQLite state, RPC handlers, character/roleplay, turns, providers, memory, work, artifacts, events, and audit. | [`host-runtime`](docs/refernece/host-runtime.md) |
| `@bear-harness/tdai-core` | Host-neutral, vendored TencentDB Agent Memory integration and L0–L3 pipeline/recall contracts. | [`tdai-core`](docs/refernece/tdai-core.md) |
| `@bear-harness/product-config` | Compile-time product identity, branding, default character, data directory, packaging, and brand-license metadata. | [`product-config`](docs/refernece/product-config.md) |
| `@bear-harness/i18n` | Product interface locales (`zh-CN`, `zh-TW`, and `en`); character-package copy remains package-owned. | [`i18n`](docs/refernece/i18n.md) |
| `@bear-harness/desktop` | Electron production shell and native packaging targets. | [`desktop`](docs/refernece/desktop.md) |
| `@bear-harness/web-dev` | Browser renderer plus loopback Node Host for local development and Playwright E2E. | [`web-dev`](docs/refernece/web-dev.md) |

## Prerequisites

The root manifest requires:

- Node.js `24.19.0`
- npm `11.17.0`
- A desktop environment for Electron development or packaging

Install dependencies from the repository root:

```sh
npm install
```

The Host runtime declares `node-llama-cpp` as an optional dependency, while Tdai Core declares it as an optional peer dependency. It is not required for the default embedding configuration; install and configure it only for an intentional local-embedding deployment. Native lifecycle scripts may require the npm 11 script approval policy used by your environment.

## Quick start

### WebDev (recommended for daily development)

```sh
npm run dev:web
```

The launcher builds the required workspace dependencies, starts a loopback Host, and serves the browser UI. It normally uses `http://127.0.0.1:3200` for the UI and `127.0.0.1:3201` for the Host, but it probes alternate ports when needed; use the URL printed by the launcher. The Host is loopback-bound and authenticated with a process-local bootstrap token. Do not expose or deploy this server as an internet-facing service.

For isolated local data, set `BEAR_WEB_DEV_DATA_DIR` before starting WebDev. The Playwright configuration supplies process-scoped test data automatically.

### Desktop

```sh
npm run dev --workspace @bear-harness/desktop
```

This starts the Electron shell with the renderer development server on the loopback development URL. The desktop shell is the production path and adds context isolation, sandboxing, disabled Node integration, preload IPC admission checks, platform credential handling, diagnostics, and artifact URL handling.

### Character package entrypoint

The shipped default package starts at [`config/characters/jizhou/character.yaml`](config/characters/jizhou/character.yaml). A package is a directory of declarations and assets, commonly including `character.yaml`, `assets/`, `canon/`, `skills/`, and optionally `plugins/`; it is content, not an unrestricted executable-code or permission bypass. The Host validates package references and applies plugin trust before executable plugins are enabled.

To author or import a package, begin with the [character package authoring guide](docs/character-package-authoring.md). The guide defines package/storage versus relationship-memory boundaries, onboarding and roleplay declarations, revisioned workshop publishing, and release checks.

## Commands

Run commands from the repository root. The root scripts are defined in [`package.json`](package.json).

### Build and development

```sh
npm run dev:web
npm run dev --workspace @bear-harness/desktop
npm run build                         # build Desktop and WebDev
npm run build --workspace @bear-harness/desktop
npm run build --workspace @bear-harness/web-dev
npm run typecheck
```

Package dependencies are rebuilt by the app launchers/builders where required. For an individual shared package, use `npm run build --workspace <workspace-name>` or its declared package script.

### Tests and verification

```sh
npm run test:unit                     # package unit suites in the root script
npm run test:coverage                 # coverage suites for Host/UI/Desktop
npm run test:e2e:web                  # WebDev Playwright journeys
npm run test:e2e:electron             # Desktop source Electron journeys
npm run test:e2e:packaged             # packaged desktop binary journeys
npm run test:diagnostics:crash        # desktop crash-diagnostics smoke
npm run check                         # lint, typecheck, coverage, builds, WebDev E2E
npm run check:electron                # build, Electron E2E, crash diagnostics
```

For a focused package check, use the scripts in that package manifest. For example:

```sh
npm run typecheck --workspace @bear-harness/protocol
npm run build --workspace @bear-harness/host-runtime
npm run test:unit --workspace @bear-harness/companion-ui
```

The [development verification guide](docs/development-verification.md) explains the default WebDev path and the additional Electron/package checks needed before a release. Do not use test totals as a compatibility promise; the scripts and observable contracts are the source of truth.

### Desktop packaging

```sh
npm run package:mac                     # universal DMG and ZIP
npm run package:win                     # x64 NSIS and ZIP
npm run package:linux                   # x64 AppImage and deb
```

These root commands invoke the corresponding Desktop workspace scripts and write release artifacts under `apps/desktop/release`. Packaging validates product configuration and includes the project notices and generated brand attribution. The current update service stages downloads only; it is not an installer, and the repository's update feed is disabled by default.

## Trust and security principles

- **Host authority:** renderers, character packages, models, and executors do not become state authorities. Host handlers validate protocol input/output and own persistence.
- **Explicit approval:** work proposals show read/write/network scope and require approval of the exact draft hash before launch. Executors report evidence and status; they do not directly mutate Host state.
- **Memory consent and separation:** direct user capture is distinct from assistant-suggested candidates, which require a user decision. Package constants/assets/resources are not relationship memory or automatic long-term-memory input.
- **Renderer isolation:** Desktop uses `contextIsolation`, sandboxing, no Node integration, strict window/frame/URL admission, and a narrow frozen preload bridge. Artifact previews use Host-issued URLs or Host-returned bytes rather than arbitrary filesystem paths.
- **Local-only WebDev:** loopback plus possession of the bootstrap token is a development boundary, not user authentication. The WebDev server has no account auth, TLS, rate limiting, or public-deployment model.
- **Credentials and updates:** credentials cross an injected vault boundary and are not exposed as renderer-readable secrets. Desktop update staging supports optional SHA-256 checks but does not provide code-signature or notarization verification; production distribution must add a publisher trust gate.
- **Defense in depth:** schemas bound sizes and vocabularies, but handlers still own path traversal, URL policy, authorization, secret redaction, and filesystem-root checks.

## Documentation

The reference directory spelling is intentional: [`docs/refernece/`](docs/refernece/).

- [`Reference index`](docs/refernece/index.md) — module map and reading order.
- [`Architecture`](docs/refernece/architecture.md) — cross-package data/control flow and boundaries.
- [`Issues and findings`](docs/refernece/issues-and-findings.md) — implementation observations and their resolved remediation, classified separately from intended behavior.
- [`Remediation status`](docs/refernece/remediation-status.md) — completed F001–F075 remediation record with final gate results.
- Module references: [`companion-client`](docs/refernece/companion-client.md), [`companion-ui`](docs/refernece/companion-ui.md), [`desktop`](docs/refernece/desktop.md), [`host-runtime`](docs/refernece/host-runtime.md), [`i18n`](docs/refernece/i18n.md), [`product-config`](docs/refernece/product-config.md), [`protocol/schema`](docs/refernece/protocol-schema.md), [`tdai-core`](docs/refernece/tdai-core.md), and [`web-dev`](docs/refernece/web-dev.md).
- [`Character package authoring`](docs/character-package-authoring.md) — package format, trust, memory ownership, and workshop workflow.
- [`Development verification`](docs/development-verification.md) — WebDev-first checks and release-time Electron checks.
- [`Role-first work interaction plan`](docs/role-first-work-interaction-plan.md) — user-facing work timeline and result principles.
- [`Bear Harness plan`](docs/bear-harness-plan.md) and [`roadmap`](docs/roadmap.md) — product direction and planned scope.

## Contributing

Choose the owning boundary before editing. A new capability normally requires a versioned schema and RPC entry, a Host handler, a typed client call, and a narrow UI projection; do not create a parallel channel or hand-written transport contract. Keep Electron/Node imports out of transport-neutral packages, keep character copy in character packages, and add product UI copy through `@bear-harness/i18n` (`zh-CN` first, then `en`, then regenerate `zh-TW`). Vendored Tdai source follows its upstream synchronization policy rather than opportunistic formatting changes.

For every change, run the narrowest relevant build, typecheck, unit/E2E journey, or manual smoke path, then broaden to the root checks when the change crosses package boundaries. Verify observable behavior at the Host/protocol boundary as well as the UI. Review the [reference findings](docs/refernece/issues-and-findings.md) before treating an implementation observation as an intended guarantee.

## Licensing

- Repository code is licensed under [GNU GPL-3.0](LICENSE).
- Cyber Bear brand assets — including the name, 极昼/Jizhou, setting, storyline, copy, and visual assets — are licensed under [CC BY-SA 4.0](BRAND-LICENSE). Attribution and modification notices are required; the CC license grants no trademark rights or implied endorsement.
- `@bear-harness/tdai-core` contains vendored upstream TencentDB Agent Memory code under its recorded [MIT license](packages/tdai-core/LICENSE). Review the relevant package and dependency notices when redistributing a build.
