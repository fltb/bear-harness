# Issues and findings

> Implementation findings aggregated from source-grounded module audits across the nine module references. This is an actionable queue, not a claim that any unverified or open finding has been fixed. The intentional directory spelling `docs/refernece/` is preserved.

## Scope and reading guide

- **Scope:** aggregated from source-grounded module audits across the nine module references. The audits produced 75 entries; 74 are open and one is recorded under resolved-during-documentation observations.
- **Deduplication:** entries that describe the same boundary are combined only where the module audits explicitly identified duplicate evidence (notably publisher-authenticated updates); both source modules remain named in the evidence. No finding is silently discarded.
- **Confidence:** `confirmed` means the cited source behavior is established by the module audits; `needs reproduction` preserves a remaining runtime/limit check. A classification such as “Confirmed bug” does not override a `needs reproduction` confidence label.
- **Priority:** P1 blocks safe operation or can cross a security/data boundary; P2 is an important correctness, contract, or operational risk; P3 is a lower-urgency limitation or maintenance debt.
- **Reference links:** each finding links to its module document’s `Known issues / findings` section. Source paths and symbols are retained in the module/path field.

## Prioritized queue

The queue excludes the one resolved observation; F019 remains open for stale-directory cleanup even though process-level isolation is addressed. Detailed entries below are the source of truth for evidence and next actions.

### P1

| ID | Finding | Module reference | Next action | Confidence |
| --- | --- | --- | --- | --- |
| F005 | [Normalize handler-thrown protocol error kinds](#f005) | [companion-client.md](./companion-client.md#known-issues--findings) | allowlist/normalize handler error kinds before constructing the envelope | `confirmed` |
| F031 | [Add publisher authentication before enabling updates](#f031) | [product-config.md](./product-config.md#known-issues--findings), [desktop.md](./desktop.md#known-issues--findings) | add code-signing/notarization verification and authenticated update metadata before enabling a public feed | `confirmed` |
| F041 | [Enforce tdai recall and capture flags](#f041) | [tdai-core.md](./tdai-core.md#known-issues--findings) | enforce flags in the facade entrypoints | `confirmed` |
| F045 | [Harden standalone workspace path containment](#f045) | [tdai-core.md](./tdai-core.md#known-issues--findings) | resolve real paths and verify containment with a path-relative/boundary-safe check | `confirmed` |
| F050 | [Require integrity for production update archives](#f050) | [desktop.md](./desktop.md#known-issues--findings) | disallow null for production feeds or require publisher authentication | `confirmed` |
| F051 | [Require HTTPS for production updates](#f051) | [desktop.md](./desktop.md#known-issues--findings) | require HTTPS before production staging | `confirmed` |
| F052 | [Address Linux plaintext credential fallback](#f052) | [desktop.md](./desktop.md#known-issues--findings) | surface this state to users/security policy and require stronger storage where plaintext is unacceptable | `confirmed` |
| F065 | [Make HostRuntime startup retry-safe](#f065) | [host-runtime.md](./host-runtime.md#known-issues--findings) | set started after success or track/roll back partial initialization | `confirmed` |
| F066 | [Capture turns in the active character namespace](#f066) | [host-runtime.md](./host-runtime.md#known-issues--findings) | resolve active companion at commit time | `confirmed` |
| F067 | [Persist approved memory scope consistently](#f067) | [host-runtime.md](./host-runtime.md#known-issues--findings) | persist the effective decided scope consistently | `confirmed` |
| F068 | [Verify memory candidates before rejection](#f068) | [host-runtime.md](./host-runtime.md#known-issues--findings) | require a successful owned pending-row transition before inserting the decision | `confirmed` |
| F069 | [Scope work records to the active companion](#f069) | [host-runtime.md](./host-runtime.md#known-issues--findings) | scope lists and snapshot projections through active companion/conversation ownership | `confirmed` |
| F070 | [Reconcile executor profile contracts](#f070) | [host-runtime.md](./host-runtime.md#known-issues--findings) | remove the unsupported type or migrate/register it end to end | `confirmed` |
| F072 | [Remove the global Host bridge on teardown](#f072) | [host-runtime.md](./host-runtime.md#known-issues--findings) | uninstall or replace the bridge during stop with ownership checks | `confirmed` |

### P2

| ID | Finding | Module reference | Next action | Confidence |
| --- | --- | --- | --- | --- |
| F001 | [Validate envelopes in the exported unwrap helper](#f001) | [companion-client.md](./companion-client.md#known-issues--findings) | validate the complete envelope or narrow the helper's documented/type contract | `confirmed` |
| F003 | [Make Electron IPC registration lifecycle-safe](#f003) | [companion-client.md](./companion-client.md#known-issues--findings) | make lifecycle ownership single-shot or add an explicit registration guard/removal path | `confirmed` |
| F006 | [Reconcile the store's missing-client contract](#f006) | [companion-client.md](./companion-client.md#known-issues--findings) | either implement the mode end to end or remove/correct the contract text | `confirmed` |
| F007 | [Define call cancellation and timeout ownership](#f007) | [companion-client.md](./companion-client.md#known-issues--findings) | define transport-specific timeout/cancellation behavior and do not retry mutations without an idempotency contract | `confirmed` |
| F010 | [Remove the locale generator's stale-dist hazard](#f010) | [i18n.md](./i18n.md#known-issues--findings) | make generation establish fresh input or enforce/document the full build sequence | `confirmed` |
| F012 | [Guard locale values at runtime](#f012) | [i18n.md](./i18n.md#known-issues--findings) | perform the existing locale membership check inside the public function | `confirmed` |
| F013 | [Reconcile the source-language interpolation placeholder](#f013) | [i18n.md](./i18n.md#known-issues--findings) | reproduce the rendered string, then use the configured delimiter form if confirmed | `needs reproduction` |
| F014 | [Surface locale storage and language-change failures](#f014) | [i18n.md](./i18n.md#known-issues--findings) | define failure handling at the module or application boundary | `confirmed` |
| F015 | [Keep the broad WebDev token strictly local](#f015) | [web-dev.md](./web-dev.md#known-issues--findings) | retain strict loopback/dev-only deployment and add stronger auth before any broader exposure | `confirmed` |
| F016 | [Preserve WebDev request failure categories](#f016) | [web-dev.md](./web-dev.md#known-issues--findings) | distinguish body-limit, JSON parse, validation, and internal dispatch failures while preserving safe envelopes | `confirmed` |
| F017 | [Validate WebDev bootstrap responses at the boundary](#f017) | [web-dev.md](./web-dev.md#known-issues--findings) | validate bootstrap immediately and keep endpoint-envelope validation at the companion client boundary | `confirmed` |
| F018 | [Close WebDev port-selection races](#f018) | [web-dev.md](./web-dev.md#known-issues--findings) | bind atomically or add bounded retry/relocation where compatible with the test contract | `confirmed` |
| F019 | [Clean process-scoped WebDev data directories](#f019) | [web-dev.md](./web-dev.md#known-issues--findings) | remove scoped roots during orderly test teardown and retain failure artifacts only deliberately | `confirmed` |
| F022 | [Do not deploy the WebDev host as production](#f022) | [web-dev.md](./web-dev.md#known-issues--findings) | keep production deployment out of scope or design a separate hardened service | `confirmed` |
| F023 | [Enforce product validation in every consumer workflow](#f023) | [product-config.md](./product-config.md#known-issues--findings) | require the validator in every build/release consumer or provide a reusable runtime validator | `confirmed` |
| F024 | [Validate the default character package exists](#f024) | [product-config.md](./product-config.md#known-issues--findings) | add a package-existence CI check or startup smoke | `confirmed` |
| F025 | [Use the shared ProductConfig type for WebDev bootstrap](#f025) | [product-config.md](./product-config.md#known-issues--findings) | type product as the shared readonly ProductConfig shape | `confirmed` |
| F026 | [Include brand changes in fork identity detection](#f026) | [product-config.md](./product-config.md#known-issues--findings) | include brand-license identity in generic change detection | `confirmed` |
| F027 | [Align icon validation with its static type](#f027) | [product-config.md](./product-config.md#known-issues--findings) | reject undefined dynamically or make omission part of the type | `confirmed` |
| F028 | [Contain product icon paths within the repository](#f028) | [product-config.md](./product-config.md#known-issues--findings) | require a normalized relative path contained under repository root | `confirmed` |
| F029 | [Validate updateFeedUrl during product validation](#f029) | [product-config.md](./product-config.md#known-issues--findings) | validate optional string/URL policy in product config before packaging | `confirmed` |
| F030 | [Generate attribution before packaging](#f030) | [product-config.md](./product-config.md#known-issues--findings) | make attribution generation an explicit packaging prerequisite/dependency | `confirmed` |
| F033 | [Complete the protocol type facade](#f033) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | export aliases for every public registered endpoint type | `confirmed` |
| F035 | [Validate domain event payloads at consuming boundaries](#f035) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | retain explicit producer/consumer guards or introduce a discriminated event registry | `confirmed` |
| F036 | [Enforce protocol cross-field relationships](#f036) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | verify each relationship in the owning package/handler validator before acceptance | `needs reproduction` |
| F037 | [Reject empty response identifiers](#f037) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | add non-empty constraints where empty is not a meaningful wire value | `confirmed` |
| F038 | [Enforce security policy beyond shape validation](#f038) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | enforce policy at owning handler/storage boundaries | `confirmed` |
| F039 | [Review weak collection and record bounds](#f039) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | reproduce realistic limits, then add bounds where input is untrusted | `needs reproduction` |
| F043 | [Align tdai reporting defaults](#f043) | [tdai-core.md](./tdai-core.md#known-issues--findings) | align documentation/default deliberately | `confirmed` |
| F044 | [Reconcile local embedding configuration](#f044) | [tdai-core.md](./tdai-core.md#known-issues--findings) | either expose local mode with dependency/download policy or remove it from the external contract | `confirmed` |
| F046 | [Canonicalize tdai store cache keys](#f046) | [tdai-core.md](./tdai-core.md#known-issues--findings) | canonicalize dataDir before caching and reset only after close | `confirmed` |
| F047 | [Clarify the tdai integration export surface](#f047) | [tdai-core.md](./tdai-core.md#known-issues--findings) | expose the intended integration API or explicitly own resolved configuration in the host adapter | `confirmed` |
| F048 | [Validate TCVDB model dimensions](#f048) | [tdai-core.md](./tdai-core.md#known-issues--findings) | validate model output dimensions before deployment/index creation | `needs reproduction` |
| F049 | [Recover incomplete background L0 indexing](#f049) | [tdai-core.md](./tdai-core.md#known-issues--findings) | provide observable reindex/retry and do not treat capture counts as final vector completeness | `confirmed` |
| F053 | [Align artifact and IPC sender checks](#f053) | [desktop.md](./desktop.md#known-issues--findings) | make referrer admission exact or preserve current navigation invariants with tests | `confirmed` |
| F054 | [Define staged-update apply and cleanup lifecycle](#f054) | [desktop.md](./desktop.md#known-issues--findings) | define installer/cleanup lifecycle before presenting automatic updates | `confirmed` |
| F057 | [Use the adopted message version in ResultSpace](#f057) | [companion-ui.md](./companion-ui.md#known-issues--findings) | share the adopted-version selection helper | `confirmed` |
| F060 | [Make ambient media dismissal authoritative](#f060) | [companion-ui.md](./companion-ui.md#known-issues--findings) | add an authoritative Host dismissal/stop transition or document re-presentation | `confirmed` |
| F061 | [Do not mask unrelated ResultSpace context errors](#f061) | [companion-ui.md](./companion-ui.md#known-issues--findings) | catch only the expected missing-context error | `confirmed` |
| F062 | [Avoid empty or synthetic media captions](#f062) | [companion-ui.md](./companion-ui.md#known-issues--findings) | expose real captions when available and avoid rendering empty track sources | `confirmed` |
| F071 | [Clarify model-expression suppression lifetime](#f071) | [host-runtime.md](./host-runtime.md#known-issues--findings) | clarify desired lifetime and reset at the matching turn boundary if per-turn behavior is intended | `needs reproduction` |
| F073 | [Contain HF_ENDPOINT to runtime lifetime](#f073) | [host-runtime.md](./host-runtime.md#known-issues--findings) | avoid global mutation or restore the owned previous value safely | `confirmed` |

### P3

| ID | Finding | Module reference | Next action | Confidence |
| --- | --- | --- | --- | --- |
| F002 | [Document transport rejection versus RPC failure](#f002) | [companion-client.md](./companion-client.md#known-issues--findings) | document and preserve the split at every transport boundary | `confirmed` |
| F004 | [Align dispatcher registration documentation and behavior](#f004) | [companion-client.md](./companion-client.md#known-issues--findings) | align the comment and implementation, preferably validating registration | `confirmed` |
| F008 | [Document host response-violation modes](#f008) | [companion-client.md](./companion-client.md#known-issues--findings) | document the host-specific mode wherever runtimes are constructed | `confirmed` |
| F009 | [Keep request-only registry usage explicit](#f009) | [companion-client.md](./companion-client.md#known-issues--findings) | use RPC or CHANNEL_CONTRACTS for full metadata and retain the request-only warning | `confirmed` |
| F011 | [Preserve runtime catalog parity checks](#f011) | [i18n.md](./i18n.md#known-issues--findings) | keep the catalog parity test mandatory or add a static shape constraint | `confirmed` |
| F020 | [Document persistent manual WebDev state](#f020) | [web-dev.md](./web-dev.md#known-issues--findings) | keep this explicit in developer guidance and use the override when isolation is required | `confirmed` |
| F021 | [Treat WebDev diagnostics as intentionally lossy](#f021) | [web-dev.md](./web-dev.md#known-issues--findings) | retain the local-diagnostics framing or add acknowledged durable collection as a separate design | `confirmed` |
| F032 | [Keep character branding outside product config](#f032) | [product-config.md](./product-config.md#known-issues--findings) | change defaultCharacterId and ship corresponding character content in fork workflow | `confirmed` |
| F034 | [Make payload-versus-envelope validation explicit](#f034) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | keep transport helpers explicit about payload versus envelope and use IpcResponse(endpoint.response) | `confirmed` |
| F040 | [Treat endpoint versioning as naming-only](#f040) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | preserve v1 compatibility and add new versioned channels for breaking changes | `confirmed` |
| F042 | [Correct tdai pipeline timing comments](#f042) | [tdai-core.md](./tdai-core.md#known-issues--findings) | update comments to parser behavior without changing runtime timing implicitly | `confirmed` |
| F055 | [Dispose desktop window hooks explicitly](#f055) | [desktop.md](./desktop.md#known-issues--findings) | retain and invoke the disposer on webContents destruction | `needs reproduction` |
| F056 | [Correct single-instance lifecycle comments](#f056) | [desktop.md](./desktop.md#known-issues--findings) | consolidate comments around actual guard behavior | `confirmed` |
| F058 | [Complete semantic color token coverage](#f058) | [companion-ui.md](./companion-ui.md#known-issues--findings) | migrate touched surfaces to existing semantic tokens rather than adding parallel colors | `confirmed` |
| F059 | [Document hard desktop layout minimums](#f059) | [companion-ui.md](./companion-ui.md#known-issues--findings) | retain as a documented desktop constraint or design a separate responsive layout | `confirmed` |
| F063 | [Define UI error-presentation ownership](#f063) | [companion-ui.md](./companion-ui.md#known-issues--findings) | document which layer owns each operation's error presentation | `confirmed` |
| F064 | [Test shortcuts under application landmark semantics](#f064) | [companion-ui.md](./companion-ui.md#known-issues--findings) | accessibility-test each added shortcut against the existing application landmark | `confirmed` |
| F075 | [Make moderation timeout coverage scheduler-tolerant](#f075) | [host-runtime.md](./host-runtime.md#known-issues--findings) | use fake timers or assert abort/fail-open behavior with scheduler tolerance instead of an exact wall-clock lower bound | `confirmed` |

## Confirmed bugs

<a id="f001"></a>
### F001: Validate envelopes in the exported unwrap helper

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — packages/companion-client/src/unwrap.ts, unwrap
- **Evidence:** the exported helper accepts {ok:true} without validating data and malformed failures without validating error, despite its defensive comment.
- **Impact:** direct callers can receive undefined as a typed success or an unrelated generic failure
- **Next action:** validate the complete envelope or narrow the helper's documented/type contract
- **Confidence:** `confirmed`

<a id="f005"></a>
### F005: Normalize handler-thrown protocol error kinds

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — Dispatcher catch path and IpcErrorKind
- **Evidence:** any thrown err.kind string is copied into the envelope although the protocol permits only five kinds.
- **Impact:** the client rejects the resulting malformed envelope instead of receiving a stable protocol failure
- **Next action:** allowlist/normalize handler error kinds before constructing the envelope
- **Confidence:** `confirmed`

<a id="f013"></a>
### F013: Reconcile the source-language interpolation placeholder

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — canonStudio.sourceLanguage catalog entry and i18next interpolation configuration
- **Evidence:** this key uses {{language}} while configured delimiters are { and }.
- **Impact:** the placeholder may render literally or inconsistently
- **Next action:** reproduce the rendered string, then use the configured delimiter form if confirmed
- **Confidence:** `needs reproduction`

<a id="f026"></a>
### F026: Include brand changes in fork identity detection

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — validate-product-config.mjs IDENTITY_FIELDS and brandLicense
- **Evidence:** brand-only identity changes can evade generic modified=true detection, although the upstream exact gate catches them.
- **Impact:** a fork can generate an untruthful modification declaration
- **Next action:** include brand-license identity in generic change detection
- **Confidence:** `confirmed`

<a id="f041"></a>
### F041: Enforce tdai recall and capture flags

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — TdaiCore.handleBeforeRecall and handleTurnCommitted
- **Evidence:** the facade invokes recall/capture without checking cfg.recall.enabled or cfg.capture.enabled.
- **Impact:** disabling these features in config does not stop them for unconditional hosts
- **Next action:** enforce flags in the facade entrypoints
- **Confidence:** `confirmed`

<a id="f057"></a>
### F057: Use the adopted message version in ResultSpace

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — ConversationPanel MessageItem adoption and ResultSpace source summary
- **Evidence:** display uses adoptedVersion while ResultSpace uses versions.at(-1).
- **Impact:** result header can describe a non-visible message version
- **Next action:** share the adopted-version selection helper
- **Confidence:** `confirmed`

<a id="f066"></a>
### F066: Capture turns in the active character namespace

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — runtime.ts onTurnCommitted namespaceFor
- **Evidence:** capture uses productConfig.defaultCharacterId while other memory helpers resolve active companion.
- **Impact:** turns after activation are stored under the wrong character namespace
- **Next action:** resolve active companion at commit time
- **Confidence:** `confirmed`

<a id="f067"></a>
### F067: Persist approved memory scope consistently

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — RPC.memory.candidateApprove
- **Evidence:** SQLite relationship entry uses suggestedScope while backend metadata uses decidedScope when supplied.
- **Impact:** the same approved memory has conflicting scopes in UI/persistence and recall
- **Next action:** persist the effective decided scope consistently
- **Confidence:** `confirmed`

<a id="f068"></a>
### F068: Verify memory candidates before rejection

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — memory.candidateReject
- **Evidence:** update may match no active pending candidate, but a memory_decisions row is inserted unconditionally.
- **Impact:** nonexistent, already-decided, or foreign candidate IDs create orphan decisions instead of not-found/conflict
- **Next action:** require a successful owned pending-row transition before inserting the decision
- **Confidence:** `confirmed`

## Contract mismatches

<a id="f006"></a>
### F006: Reconcile the store's missing-client contract

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — createCompanionStore, CompanionClient parameter, event loop, derivePresence
- **Evidence:** comments describe an absent client as unavailable/idle, but the client is required and invoked unconditionally, and unavailable maps to problem.
- **Impact:** maintainers can code against a nonexistent missing-client mode
- **Next action:** either implement the mode end to end or remove/correct the contract text
- **Confidence:** `confirmed`

<a id="f012"></a>
### F012: Guard locale values at runtime

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — setProductLocale
- **Evidence:** the public function relies only on ProductLocale typing and accepts arbitrary strings at untyped boundaries.
- **Impact:** unsupported values can be persisted and applied to html/i18next
- **Next action:** perform the existing locale membership check inside the public function
- **Confidence:** `confirmed`

<a id="f017"></a>
### F017: Validate WebDev bootstrap responses at the boundary

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — loadBootstrap and createHttpTransport
- **Evidence:** bootstrap JSON is cast without runtime validation and successful transport JSON is returned unvalidated until later client/UI paths.
- **Impact:** unexpected proxy responses fail far from the boundary
- **Next action:** validate bootstrap immediately and keep endpoint-envelope validation at the companion client boundary
- **Confidence:** `confirmed`

<a id="f025"></a>
### F025: Use the shared ProductConfig type for WebDev bootstrap

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — apps/web-dev/src/http-client.ts, WebDevBootstrap.product
- **Evidence:** server returns full ProductConfig including updateFeedUrl, but the static client type ends at icon.
- **Impact:** current UI is unaffected, but typed bootstrap consumers see an incomplete contract
- **Next action:** type product as the shared readonly ProductConfig shape
- **Confidence:** `confirmed`

<a id="f027"></a>
### F027: Align icon validation with its static type

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — ProductConfig.icon type and dynamic validator
- **Evidence:** TypeScript requires string|null while validation accepts undefined.
- **Impact:** typed and dynamic consumers disagree on accepted config
- **Next action:** reject undefined dynamically or make omission part of the type
- **Confidence:** `confirmed`

<a id="f029"></a>
### F029: Validate updateFeedUrl during product validation

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — ProductConfig.updateFeedUrl and generic validator
- **Evidence:** no runtime type or scheme validation occurs until update checking.
- **Impact:** malformed configuration fails late
- **Next action:** validate optional string/URL policy in product config before packaging
- **Confidence:** `confirmed`

<a id="f033"></a>
### F033: Complete the protocol type facade

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — packages/protocol/src/index.ts exports versus schema.ts/RPC
- **Evidence:** many registered request/response types are not re-exported, including run interrupt/resume and artifact read/url requests.
- **Impact:** type-only consumers must import runtime schema internals
- **Next action:** export aliases for every public registered endpoint type
- **Confidence:** `confirmed`

<a id="f037"></a>
### F037: Reject empty response identifiers

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — provider/model/commission/run/artifact response IDs
- **Evidence:** several base response schemas allow empty strings while related requests often require non-empty IDs.
- **Impact:** response validation can accept unusable identities
- **Next action:** add non-empty constraints where empty is not a meaningful wire value
- **Confidence:** `confirmed`

<a id="f043"></a>
### F043: Align tdai reporting defaults

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — ReportConfig comment and parseConfig
- **Evidence:** interface says reporting defaults enabled, parser resolves false.
- **Impact:** integrations can infer the wrong reporting state
- **Next action:** align documentation/default deliberately
- **Confidence:** `confirmed`

<a id="f044"></a>
### F044: Reconcile local embedding configuration

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — EmbeddingConfig, parseConfig, createEmbeddingService
- **Evidence:** internal local embedding exists but user config rewrites local to none with configError.
- **Impact:** advertised configuration cannot activate the implementation
- **Next action:** either expose local mode with dependency/download policy or remove it from the external contract
- **Confidence:** `confirmed`

<a id="f047"></a>
### F047: Clarify the tdai integration export surface

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — tdai-core package root exports
- **Evidence:** parseConfig and concrete stores/embedding classes are omitted despite the facade expecting resolved config.
- **Impact:** consumers use internal imports or duplicate resolution, increasing sync coupling
- **Next action:** expose the intended integration API or explicitly own resolved configuration in the host adapter
- **Confidence:** `confirmed`

<a id="f060"></a>
### F060: Make ambient media dismissal authoritative

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — ambient roleplay media dismissal
- **Evidence:** renderer clears only its active ID and sends no Host stop RPC.
- **Impact:** snapshots/events can re-present media the Host still reports
- **Next action:** add an authoritative Host dismissal/stop transition or document re-presentation
- **Confidence:** `confirmed`

<a id="f070"></a>
### F070: Reconcile executor profile contracts

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — ExecutorProfileType/PROFILE_TYPES versus SQLite executor_profiles constraint and registered controllers
- **Evidence:** router accepts native-full but schema permits only product-managed/codex.
- **Impact:** native-full cannot be persisted or resolved
- **Next action:** remove the unsupported type or migrate/register it end to end
- **Confidence:** `confirmed`

## Security risks

<a id="f015"></a>
### F015: Keep the broad WebDev token strictly local

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev /bootstrap token and authenticated RPC/debug routes
- **Evidence:** any loopback client can obtain one bearer token authorizing the full surface, with no user/capability split.
- **Impact:** any local process can invoke all dev-host operations
- **Next action:** retain strict loopback/dev-only deployment and add stronger auth before any broader exposure
- **Confidence:** `confirmed`

<a id="f028"></a>
### F028: Contain product icon paths within the repository

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — product icon path validation
- **Evidence:** the validator resolves paths against repo root but does not reject absolute paths or traversal before resolution.
- **Impact:** untrusted configuration could read/package an unintended file
- **Next action:** require a normalized relative path contained under repository root
- **Confidence:** `confirmed`

<a id="f031"></a>
### F031: Add publisher authentication before enabling updates

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings), [desktop.md](./desktop.md#known-issues--findings) — desktop packaging, update feed, UpdateService, product update guidance
- **Evidence:** packages are unsigned, staged updates lack signature/notarization verification, and sha256:null can bypass digest verification. This deduplicates desktop finding 1 and product-config finding 9 while retaining both evidence sources.
- **Impact:** a checksum or ready state does not authenticate a publisher
- **Next action:** add code-signing/notarization verification and authenticated update metadata before enabling a public feed
- **Confidence:** `confirmed`

<a id="f038"></a>
### F038: Enforce security policy beyond shape validation

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — provider/settings URL, credential and import fields
- **Evidence:** schemas bound size only; they do not enforce URL scheme/host policy, redaction, authorization, or encryption.
- **Impact:** unsafe destinations or secret leakage remain possible if handlers assume schema validation is sufficient
- **Next action:** enforce policy at owning handler/storage boundaries
- **Confidence:** `confirmed`

<a id="f039"></a>
### F039: Review weak collection and record bounds

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — unbounded records and theme strings
- **Evidence:** multiple records have no entry cap and theme strings omit shared maximums.
- **Impact:** untrusted package data can consume more memory/work than common bounds imply
- **Next action:** reproduce realistic limits, then add bounds where input is untrusted
- **Confidence:** `needs reproduction`

<a id="f045"></a>
### F045: Harden standalone workspace path containment

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — standalone llm-runner resolveSandboxedPath
- **Evidence:** startsWith lacks a separator boundary and symlinks are not resolved.
- **Impact:** a sibling prefix path or in-workspace symlink can escape workspaceDir through tool-enabled runs
- **Next action:** resolve real paths and verify containment with a path-relative/boundary-safe check
- **Confidence:** `confirmed`

<a id="f050"></a>
### F050: Require integrity for production update archives

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — UpdateService sha256 contract
- **Evidence:** explicit sha256:null reaches ready without digest verification.
- **Impact:** archive integrity is absent unless another authenticated trust layer exists
- **Next action:** disallow null for production feeds or require publisher authentication
- **Confidence:** `confirmed`

<a id="f051"></a>
### F051: Require HTTPS for production updates

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — UpdateService.stage
- **Evidence:** both http and https archive URLs are accepted, including downgrade from an HTTPS feed.
- **Impact:** network attackers can alter an unauthenticated archive
- **Next action:** require HTTPS before production staging
- **Confidence:** `confirmed`

<a id="f052"></a>
### F052: Address Linux plaintext credential fallback

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — Linux safeStorage/CredentialStore fallback
- **Evidence:** unavailable safeStorage writes raw UTF-8 credentials marked weak_storage.
- **Impact:** provider secrets are plaintext at rest
- **Next action:** surface this state to users/security policy and require stronger storage where plaintext is unacceptable
- **Confidence:** `confirmed`

<a id="f053"></a>
### F053: Align artifact and IPC sender checks

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — artifact-protocol.ts packaged referrer admission
- **Evidence:** IPC requires exact file URL, while artifact serving accepts any or empty file referrer.
- **Impact:** future local navigation paths would have broader artifact access than IPC
- **Next action:** make referrer admission exact or preserve current navigation invariants with tests
- **Confidence:** `confirmed`

<a id="f069"></a>
### F069: Scope work records to the active companion

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — commission.list, run.list, snapshot.get
- **Evidence:** reads are not filtered/joined to active companion and snapshots include the broad lists.
- **Impact:** switching character packages can expose other characters' work records/artifacts
- **Next action:** scope lists and snapshot projections through active companion/conversation ownership
- **Confidence:** `confirmed`

## Reliability/operability risks

<a id="f003"></a>
### F003: Make Electron IPC registration lifecycle-safe

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — apps/desktop/src/main/ipc-router.ts, wireElectronIpcHandlers
- **Evidence:** each invocation calls ipcMain.handle for all channels and Electron rejects duplicate registration.
- **Impact:** repeated wiring in one process fails startup
- **Next action:** make lifecycle ownership single-shot or add an explicit registration guard/removal path
- **Confidence:** `confirmed`

<a id="f014"></a>
### F014: Surface locale storage and language-change failures

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — i18n module initialization and setProductLocale
- **Evidence:** localStorage calls are not guarded and init/changeLanguage promises are discarded.
- **Impact:** throwing storage or rejected language changes have no diagnostic/recovery path
- **Next action:** define failure handling at the module or application boundary
- **Confidence:** `confirmed`

<a id="f016"></a>
### F016: Preserve WebDev request failure categories

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — apps/web-dev/server/index.ts RPC catch block
- **Evidence:** oversized bodies, malformed JSON, schema/dispatch exceptions, and other failures all become invalid json.
- **Impact:** operators lose the actual failure category
- **Next action:** distinguish body-limit, JSON parse, validation, and internal dispatch failures while preserving safe envelopes
- **Confidence:** `confirmed`

<a id="f018"></a>
### F018: Close WebDev port-selection races

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev availablePort, Rsbuild strictPort, rule-provider fixed port
- **Evidence:** port probing is check-then-bind and the provider uses a fixed port.
- **Impact:** another process can win the race or collide, causing startup/readiness failure
- **Next action:** bind atomically or add bounded retry/relocation where compatible with the test contract
- **Confidence:** `confirmed`

<a id="f019"></a>
### F019: Clean process-scoped WebDev data directories

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev E2E process-scoped data directories
- **Evidence:** process scoping prevents state sharing, but launcher/Playwright never remove old .process-* directories.
- **Impact:** stale state and credentials accumulate under test-results
- **Next action:** remove scoped roots during orderly test teardown and retain failure artifacts only deliberately
- **Confidence:** `confirmed`

<a id="f024"></a>
### F024: Validate the default character package exists

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — defaultCharacterId validation and Host startup
- **Evidence:** syntax is checked but package existence is not; Host later throws for a missing package.
- **Impact:** a seemingly valid fork can fail startup
- **Next action:** add a package-existence CI check or startup smoke
- **Confidence:** `confirmed`

<a id="f036"></a>
### F036: Enforce protocol cross-field relationships

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — CharacterDisplay, roleplay and onboarding cross-field relationships
- **Evidence:** defaults and referenced IDs/types are not cross-validated by Zod.
- **Impact:** inconsistent package data can fail or misproject later
- **Next action:** verify each relationship in the owning package/handler validator before acceptance
- **Confidence:** `needs reproduction`

<a id="f046"></a>
### F046: Canonicalize tdai store cache keys

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — initStores cache in pipeline-factory.ts
- **Evidence:** raw directory strings are keys, so equivalent relative/absolute/symlink paths can open multiple stores over the same physical data.
- **Impact:** concurrent access and lifecycle confusion can corrupt or lock state
- **Next action:** canonicalize dataDir before caching and reset only after close
- **Confidence:** `confirmed`

<a id="f048"></a>
### F048: Validate TCVDB model dimensions

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — TcvdbMemoryStore dense index and tcvdb.embeddingModel
- **Evidence:** index dimensions are fixed at 1024 while model is configurable and config does not validate the relation.
- **Impact:** incompatible models can fail indexing/search
- **Next action:** validate model output dimensions before deployment/index creation
- **Confidence:** `needs reproduction`

<a id="f049"></a>
### F049: Recover incomplete background L0 indexing

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — deferred L0 embedding and TdaiCore.destroy
- **Evidence:** background indexing is best effort and shutdown waits only five seconds.
- **Impact:** successful capture can leave metadata-only rows/missing vectors
- **Next action:** provide observable reindex/retry and do not treat capture counts as final vector completeness
- **Confidence:** `confirmed`

<a id="f055"></a>
### F055: Dispose desktop window hooks explicitly

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — createMainWindow/registerWindowHooks
- **Evidence:** returned disposer is discarded.
- **Impact:** unusual teardown may retain listeners even though normal Electron destruction cleans objects
- **Next action:** retain and invoke the disposer on webContents destruction
- **Confidence:** `needs reproduction`

<a id="f061"></a>
### F061: Do not mask unrelated ResultSpace context errors

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — WorkPanel optional ResultSpace helper
- **Evidence:** it catches every useResultSpace error rather than only missing-provider.
- **Impact:** unrelated provider/runtime defects are silently masked
- **Next action:** catch only the expected missing-context error
- **Confidence:** `confirmed`

<a id="f065"></a>
### F065: Make HostRuntime startup retry-safe

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — HostRuntime.start
- **Evidence:** started is set before fallible proxy/memory/character/supervisor steps, so later failure makes retries no-op.
- **Impact:** partial startup cannot recover on the same instance
- **Next action:** set started after success or track/roll back partial initialization
- **Confidence:** `confirmed`

<a id="f072"></a>
### F072: Remove the global Host bridge on teardown

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — CompanionSupervisor globalThis.bearHostCall
- **Evidence:** start installs the process-global function and stop does not remove it.
- **Impact:** callers retain a stale capability after runtime close
- **Next action:** uninstall or replace the bridge during stop with ownership checks
- **Confidence:** `confirmed`

<a id="f073"></a>
### F073: Contain HF_ENDPOINT to runtime lifetime

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — process.env.HF_ENDPOINT lifecycle
- **Evidence:** constructor mutates the process-global variable from persisted settings and close does not restore it.
- **Impact:** multiple runtimes affect each other's downloads and teardown leaves state behind
- **Next action:** avoid global mutation or restore the owned previous value safely
- **Confidence:** `confirmed`

<a id="f075"></a>
### F075: Make moderation timeout coverage scheduler-tolerant

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — packages/host-runtime/tests/security-moderation.spec.ts, `ModerationService remote policy` timeout test
- **Evidence:** the test injects `timeoutMs: 20`, measures `Date.now()` around `checkText`, and requires elapsed time to be at least 20 ms; the root unit suite failed when elapsed time was 19 ms versus the required 20 ms, while the check returned the expected fail-open result.
- **Impact:** wall-clock scheduler precision can produce a nondeterministic CI failure and obscure otherwise valid moderation coverage; this is not evidence of a moderation timeout-policy failure.
- **Next action:** use fake timers or assert abort/fail-open behavior with scheduler tolerance instead of an exact lower wall-clock bound
- **Confidence:** `confirmed`

## Design limitations

<a id="f002"></a>
### F002: Document transport rejection versus RPC failure

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — HostTransport.invoke and apps/web-dev/src/http-client.ts
- **Evidence:** transport failures reject promises while RPC failures remain IpcEnvelope values.
- **Impact:** callers need two error paths and new transports can accidentally fabricate domain errors
- **Next action:** document and preserve the split at every transport boundary
- **Confidence:** `confirmed`

<a id="f007"></a>
### F007: Define call cancellation and timeout ownership

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — HostTransport and CompanionClient lifecycle
- **Evidence:** there is no cancellation, timeout, retry, or idempotency key.
- **Impact:** long calls and polling inherit transport behavior, and naive retries can duplicate mutations
- **Next action:** define transport-specific timeout/cancellation behavior and do not retry mutations without an idempotency contract
- **Confidence:** `confirmed`

<a id="f008"></a>
### F008: Document host response-violation modes

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — Dispatcher protocolViolationMode and clients
- **Evidence:** malformed response handling is Host configuration; WebDev throws while other hosts may isolate, and client validation occurs only after transport.
- **Impact:** environments expose different failure behavior
- **Next action:** document the host-specific mode wherever runtimes are constructed
- **Confidence:** `confirmed`

<a id="f011"></a>
### F011: Preserve runtime catalog parity checks

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — packages/i18n/src/locales/en.ts and catalog parity test
- **Evidence:** English is not statically constrained to typeof zhCN; parity is discovered only by tests.
- **Impact:** omitted/extra keys survive typecheck
- **Next action:** keep the catalog parity test mandatory or add a static shape constraint
- **Confidence:** `confirmed`

<a id="f020"></a>
### F020: Document persistent manual WebDev state

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — webDevDataDirectory without BEAR_WEB_DEV_DATA_DIR
- **Evidence:** manual WebDev intentionally uses the persistent platform path shared with prior runs/Electron.
- **Impact:** manual sessions can observe existing product state
- **Next action:** keep this explicit in developer guidance and use the override when isolation is required
- **Confidence:** `confirmed`

<a id="f021"></a>
### F021: Treat WebDev diagnostics as intentionally lossy

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — installRendererFaultReporting and diagnostics route
- **Evidence:** browser reporting is fire-and-forget and server data is reduced to one stderr line.
- **Impact:** faults can be lost and are not durable telemetry
- **Next action:** retain the local-diagnostics framing or add acknowledged durable collection as a separate design
- **Confidence:** `confirmed`

<a id="f022"></a>
### F022: Do not deploy the WebDev host as production

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev build/server deployment
- **Evidence:** build emits renderer assets but does not package, supervise, authenticate, or deploy server/index.ts.
- **Impact:** treating it as production-ready would expose an inappropriate dev host
- **Next action:** keep production deployment out of scope or design a separate hardened service
- **Confidence:** `confirmed`

<a id="f032"></a>
### F032: Keep character branding outside product config

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — product-config asset boundary
- **Evidence:** only the shell icon is owned here; character visuals/copy remain in character packages.
- **Impact:** renaming product/icon alone does not create an independent brand
- **Next action:** change defaultCharacterId and ship corresponding character content in fork workflow
- **Confidence:** `confirmed`

<a id="f034"></a>
### F034: Make payload-versus-envelope validation explicit

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — RPC endpoint response fields and IpcResponse
- **Evidence:** endpoint.response validates payload only; runtime envelope validation is a separate factory.
- **Impact:** transports can validate the wrong shape
- **Next action:** keep transport helpers explicit about payload versus envelope and use IpcResponse(endpoint.response)
- **Confidence:** `confirmed`

<a id="f035"></a>
### F035: Validate domain event payloads at consuming boundaries

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — DomainEvent.payload
- **Evidence:** payload is z.unknown and generic subscription cannot validate kind-specific shapes.
- **Impact:** malformed event payloads cross the generic boundary unless producers/consumers guard them
- **Next action:** retain explicit producer/consumer guards or introduce a discriminated event registry
- **Confidence:** `confirmed`

<a id="f040"></a>
### F040: Treat endpoint versioning as naming-only

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — :v1 endpoint versioning
- **Evidence:** versioning is naming-only with no negotiation, migration, or adapter.
- **Impact:** breaking changes require coordinated new channels and consumers
- **Next action:** preserve v1 compatibility and add new versioned channels for breaking changes
- **Confidence:** `confirmed`

<a id="f054"></a>
### F054: Define staged-update apply and cleanup lifecycle

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — UpdateService lifecycle
- **Evidence:** it stages version directories but never applies, rolls back, launches, or removes them.
- **Impact:** ready is not an installed update and disk use grows
- **Next action:** define installer/cleanup lifecycle before presenting automatic updates
- **Confidence:** `confirmed`

<a id="f058"></a>
### F058: Complete semantic color token coverage

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — companion-ui styles.css theme tokens
- **Evidence:** literal Tailwind/rgba colors remain on multiple themed surfaces.
- **Impact:** character theme overrides are incomplete
- **Next action:** migrate touched surfaces to existing semantic tokens rather than adding parallel colors
- **Confidence:** `confirmed`

<a id="f059"></a>
### F059: Document hard desktop layout minimums

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — body and desktop shell CSS
- **Evidence:** 1050x680 minimums plus overflow hidden and only a 1200px adjustment prevent mobile/small embedding layouts.
- **Impact:** smaller windows clip rather than reflow
- **Next action:** retain as a documented desktop constraint or design a separate responsive layout
- **Confidence:** `confirmed`

<a id="f062"></a>
### F062: Avoid empty or synthetic media captions

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — artifact and roleplay media tracks
- **Evidence:** filename/full-duration synthetic captions or empty/undefined caption URLs are used.
- **Impact:** markup is not equivalent to real captions and may request an empty URL
- **Next action:** expose real captions when available and avoid rendering empty track sources
- **Confidence:** `confirmed`

<a id="f063"></a>
### F063: Define UI error-presentation ownership

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — store/component error reporting
- **Evidence:** core errors use shared store state while supplementary methods reject to local handlers.
- **Impact:** new actions can fail without the expected alert if the wrong convention is chosen
- **Next action:** document which layer owns each operation's error presentation
- **Confidence:** `confirmed`

<a id="f064"></a>
### F064: Test shortcuts under application landmark semantics

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — root role=application and keyboard interactions
- **Evidence:** application semantics alter assistive-technology behavior around nested landmarks and shortcuts.
- **Impact:** new global shortcuts may conflict with screen-reader modes
- **Next action:** accessibility-test each added shortcut against the existing application landmark
- **Confidence:** `confirmed`

<a id="f071"></a>
### F071: Clarify model-expression suppression lifetime

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — CharacterBehaviorService modelSelectedExpression
- **Evidence:** flag is cleared on message.user_sent, not message_end, so suppression is conversation state that spans completion until another user message.
- **Impact:** lifecycle reactions can be unexpectedly suppressed
- **Next action:** clarify desired lifetime and reset at the matching turn boundary if per-turn behavior is intended
- **Confidence:** `needs reproduction`

## Documentation/tooling debt

<a id="f004"></a>
### F004: Align dispatcher registration documentation and behavior

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — Dispatcher.registerHandler documentation
- **Evidence:** the comment says unknown channels throw, but implementation only inserts endpoint.channel; rejection happens only during dispatch.
- **Impact:** typos or stale endpoints remain latent until invoked
- **Next action:** align the comment and implementation, preferably validating registration
- **Confidence:** `confirmed`

<a id="f009"></a>
### F009: Keep request-only registry usage explicit

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — REQUEST_SCHEMAS consumers
- **Evidence:** the map contains request schemas only and does not carry response or endpoint metadata.
- **Impact:** treating it as a complete registry creates incomplete clients/contracts
- **Next action:** use RPC or CHANNEL_CONTRACTS for full metadata and retain the request-only warning
- **Confidence:** `confirmed`

<a id="f010"></a>
### F010: Remove the locale generator's stale-dist hazard

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — packages/i18n/scripts/generate-zh-tw.mjs, build/generate scripts, dist exports
- **Evidence:** standalone generation imports stale or absent dist, the supported build requires two tsc passes, and consumers resolve dist rather than source. This deduplicates the first three i18n entries without dropping their separate build-chain facts.
- **Impact:** copy can be missing or stale despite source edits
- **Next action:** make generation establish fresh input or enforce/document the full build sequence
- **Confidence:** `confirmed`

<a id="f023"></a>
### F023: Enforce product validation in every consumer workflow

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — ProductConfig import/validation boundary
- **Evidence:** the package exports a plain typed object; validate-product-config.mjs runs only in external build/release workflows.
- **Impact:** new consumers can load invalid config
- **Next action:** require the validator in every build/release consumer or provide a reusable runtime validator
- **Confidence:** `confirmed`

<a id="f030"></a>
### F030: Generate attribution before packaging

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — validate-product-config.mjs output and Electron Builder resources
- **Evidence:** packaging expects dist/brand/BRAND-ATTRIBUTION.txt, but only the validator write step creates it.
- **Impact:** skipping that step yields packaging failure or incomplete notices
- **Next action:** make attribution generation an explicit packaging prerequisite/dependency
- **Confidence:** `confirmed`

<a id="f042"></a>
### F042: Correct tdai pipeline timing comments

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — PipelineConfig comments versus parseConfig
- **Evidence:** comments state 60s/90s while resolved defaults are 600s/10s.
- **Impact:** operators can tune or diagnose against wrong timing
- **Next action:** update comments to parser behavior without changing runtime timing implicitly
- **Confidence:** `confirmed`

<a id="f056"></a>
### F056: Correct single-instance lifecycle comments

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — packaged single-instance comments
- **Evidence:** adjacent comments describe per-data-dir and per-install behavior while code is app.isPackaged-gated.
- **Impact:** maintainers can change E2E/dev identity based on incorrect prose
- **Next action:** consolidate comments around actual guard behavior
- **Confidence:** `confirmed`

## Resolved-during-documentation observations

These observations are not open work items. “Resolved” is limited to the exact behavior named; adjacent cleanup or other findings remain open.

<a id="f074"></a>
### F074: WebDev E2E runs no longer share process state

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev E2E data isolation
- **Evidence:** the module reference explicitly states process-scoped directories now prevent concurrent runs from sharing state, addressing the earlier readiness/state-isolation failure mode.
- **Impact:** the concurrency defect is resolved; only cleanup accumulation remains open as a separate finding
- **Next action:** retain the process-scope unit coverage and do not reopen this item absent regression evidence
- **Confidence:** `confirmed`

**Boundary:** This does not close [F019](#f019-clean-process-scoped-webdev-data-directories), which tracks cleanup of the now-isolated directories.

