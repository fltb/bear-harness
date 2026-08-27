# Issues and findings

> Implementation findings aggregated from source-grounded module audits across the nine module references. **This is the completed remediation register: all 75 findings (F001–F075) are resolved in the current tree; zero findings remain open.** The intentional directory spelling `docs/refernece/` is preserved.

## Scope and reading guide

- **Scope:** aggregated from source-grounded module audits across the nine module references. The audits produced 75 entries (F001–F075); **all 75 are resolved and zero remain open**. The single external live-model E2E case skipped by the final gate is an environment prerequisite (it needs a real external provider), not a finding.
- **Resolution state:** every detailed entry below retains its original category, evidence, impact, next action, and confidence, and adds a `Resolution` line recording the implemented fix or final policy plus the tests/gates that prove it. No finding is misrepresented as resolved: code-fixed findings name the code change; policy-resolved findings state the exact final policy.
- **Deduplication:** entries that describe the same boundary are combined only where the module audits explicitly identified duplicate evidence (notably publisher-authenticated updates); both source modules remain named in the evidence. No finding is silently discarded.
- **Confidence:** `confirmed` means the cited source behavior is established by the module audits; `needs reproduction` preserves a remaining runtime/limit check. The confidence label describes the original audit evidence and does not affect the resolved status.
- **Priority:** P1 blocks safe operation or can cross a security/data boundary; P2 is an important correctness, contract, or operational risk; P3 is a lower-urgency limitation or maintenance debt. Priority was assigned at audit time and is retained historically in the index below.
- **Reference links:** each finding links to its module document’s `Known issues / findings` section. Source paths and symbols are retained in the module/path field. Some module reference documents still carry the pre-remediation wording of their known-issues sections; the `Resolution` entries here, cross-referenced with [remediation-status.md](./remediation-status.md), are the authoritative record of what changed.
- **Verification:** the final full gate is green — lint, typecheck, test:unit, build, test:e2e:web. See [Verification evidence](#verification-evidence) below.

## Verification evidence

The final full verification gate is green across the repository:

- `npm run lint` — pass
- `npm run typecheck` — pass
- `npm run test:unit` — pass (all package unit suites, including companion-ui, host-runtime, i18n, and desktop unit tests)
- `npm run build` — pass (all workspace packages)
- `npm run test:e2e:web` — **21 passed, 1 skipped**. The single skip is `live-model.spec.ts`, which requires a real external live model; it is an environment prerequisite, not a finding, and no work item tracks it.

Per-module remediation detail, implementation notes, and the commit boundary are recorded in [remediation-status.md](./remediation-status.md). Module-level suites that participate in the green unit gate include (verified present in the tree): `packages/companion-ui/tests` (generated-client-contract, ipc-errors, ipc-validation, result-space, work-run-controls, advanced-feature-journeys, sidebar-journey, shell-visual-contract, composer, fork-config, idle-home), `packages/host-runtime/tests` (dispatcher, database-contract, credential-store, executor-controls, composition-ownership, memory-context, turn-pipeline, security-moderation, character-behavior, continuity, roleplay-service, onboarding, update-ipc-schemas, security-audit, security-fs-protection), `packages/i18n/tests` (locale-runtime, catalogs), `packages/protocol/src/schema.memory.spec.ts`, `apps/desktop/tests` (update-service, electron-credential-vault, artifact-protocol, ipc-router, config/validate-product-config, config/product-config-validator, diagnostics/electron-wiring), `apps/web-dev/server/data-directory.spec.ts`, and the web E2E journeys (`apps/web-dev/e2e`: 00-onboarding, chat-journey, memory-journey, settings, rule-provider, character-continuity, env-contract, live-model).

## Historical priority index (all resolved)

The queue below is retained as a **historical priority index**: it records the audit-time priority classification and next action for every finding. **Every entry in this index is now resolved** — the detailed entries below are the source of truth for evidence, resolution, and verification. No entry in this index is open. F074 was recorded as resolved-during-documentation and never appeared in this queue.

### P1

| ID | Finding | Module reference | Next action | Confidence | Status |
| --- | --- | --- | --- | --- | --- |
| F005 | [Normalize handler-thrown protocol error kinds](#f005) | [companion-client.md](./companion-client.md#known-issues--findings) | allowlist/normalize handler error kinds before constructing the envelope | `confirmed` | Resolved |
| F031 | [Add publisher authentication before enabling updates](#f031) | [product-config.md](./product-config.md#known-issues--findings), [desktop.md](./desktop.md#known-issues--findings) | add code-signing/notarization verification and authenticated update metadata before enabling a public feed | `confirmed` | Resolved |
| F041 | [Enforce tdai recall and capture flags](#f041) | [tdai-core.md](./tdai-core.md#known-issues--findings) | enforce flags in the facade entrypoints | `confirmed` | Resolved |
| F045 | [Harden standalone workspace path containment](#f045) | [tdai-core.md](./tdai-core.md#known-issues--findings) | resolve real paths and verify containment with a path-relative/boundary-safe check | `confirmed` | Resolved |
| F050 | [Require integrity for production update archives](#f050) | [desktop.md](./desktop.md#known-issues--findings) | disallow null for production feeds or require publisher authentication | `confirmed` | Resolved |
| F051 | [Require HTTPS for production updates](#f051) | [desktop.md](./desktop.md#known-issues--findings) | require HTTPS before production staging | `confirmed` | Resolved |
| F052 | [Address Linux plaintext credential fallback](#f052) | [desktop.md](./desktop.md#known-issues--findings) | surface this state to users/security policy and require stronger storage where plaintext is unacceptable | `confirmed` | Resolved |
| F065 | [Make HostRuntime startup retry-safe](#f065) | [host-runtime.md](./host-runtime.md#known-issues--findings) | set started after success or track/roll back partial initialization | `confirmed` | Resolved |
| F066 | [Capture turns in the active character namespace](#f066) | [host-runtime.md](./host-runtime.md#known-issues--findings) | resolve active companion at commit time | `confirmed` | Resolved |
| F067 | [Persist approved memory scope consistently](#f067) | [host-runtime.md](./host-runtime.md#known-issues--findings) | persist the effective decided scope consistently | `confirmed` | Resolved |
| F068 | [Verify memory candidates before rejection](#f068) | [host-runtime.md](./host-runtime.md#known-issues--findings) | require a successful owned pending-row transition before inserting the decision | `confirmed` | Resolved |
| F069 | [Scope work records to the active companion](#f069) | [host-runtime.md](./host-runtime.md#known-issues--findings) | scope lists and snapshot projections through active companion/conversation ownership | `confirmed` | Resolved |
| F070 | [Reconcile executor profile contracts](#f070) | [host-runtime.md](./host-runtime.md#known-issues--findings) | remove the unsupported type or migrate/register it end to end | `confirmed` | Resolved |
| F072 | [Remove the global Host bridge on teardown](#f072) | [host-runtime.md](./host-runtime.md#known-issues--findings) | uninstall or replace the bridge during stop with ownership checks | `confirmed` | Resolved |

### P2

| ID | Finding | Module reference | Next action | Confidence | Status |
| --- | --- | --- | --- | --- | --- |
| F001 | [Validate envelopes in the exported unwrap helper](#f001) | [companion-client.md](./companion-client.md#known-issues--findings) | validate the complete envelope or narrow the helper's documented/type contract | `confirmed` | Resolved |
| F003 | [Make Electron IPC registration lifecycle-safe](#f003) | [companion-client.md](./companion-client.md#known-issues--findings) | make lifecycle ownership single-shot or add an explicit registration guard/removal path | `confirmed` | Resolved |
| F006 | [Reconcile the store's missing-client contract](#f006) | [companion-client.md](./companion-client.md#known-issues--findings) | either implement the mode end to end or remove/correct the contract text | `confirmed` | Resolved |
| F007 | [Define call cancellation and timeout ownership](#f007) | [companion-client.md](./companion-client.md#known-issues--findings) | define transport-specific timeout/cancellation behavior and do not retry mutations without an idempotency contract | `confirmed` | Resolved |
| F010 | [Remove the locale generator's stale-dist hazard](#f010) | [i18n.md](./i18n.md#known-issues--findings) | make generation establish fresh input or enforce/document the full build sequence | `confirmed` | Resolved |
| F012 | [Guard locale values at runtime](#f012) | [i18n.md](./i18n.md#known-issues--findings) | perform the existing locale membership check inside the public function | `confirmed` | Resolved |
| F013 | [Reconcile the source-language interpolation placeholder](#f013) | [i18n.md](./i18n.md#known-issues--findings) | reproduce the rendered string, then use the configured delimiter form if confirmed | `needs reproduction` | Resolved |
| F014 | [Surface locale storage and language-change failures](#f014) | [i18n.md](./i18n.md#known-issues--findings) | define failure handling at the module or application boundary | `confirmed` | Resolved |
| F015 | [Keep the broad WebDev token strictly local](#f015) | [web-dev.md](./web-dev.md#known-issues--findings) | retain strict loopback/dev-only deployment and add stronger auth before any broader exposure | `confirmed` | Resolved |
| F016 | [Preserve WebDev request failure categories](#f016) | [web-dev.md](./web-dev.md#known-issues--findings) | distinguish body-limit, JSON parse, validation, and internal dispatch failures while preserving safe envelopes | `confirmed` | Resolved |
| F017 | [Validate WebDev bootstrap responses at the boundary](#f017) | [web-dev.md](./web-dev.md#known-issues--findings) | validate bootstrap immediately and keep endpoint-envelope validation at the companion client boundary | `confirmed` | Resolved |
| F018 | [Close WebDev port-selection races](#f018) | [web-dev.md](./web-dev.md#known-issues--findings) | bind atomically or add bounded retry/relocation where compatible with the test contract | `confirmed` | Resolved |
| F019 | [Clean process-scoped WebDev data directories](#f019) | [web-dev.md](./web-dev.md#known-issues--findings) | remove scoped roots during orderly test teardown and retain failure artifacts only deliberately | `confirmed` | Resolved |
| F022 | [Do not deploy the WebDev host as production](#f022) | [web-dev.md](./web-dev.md#known-issues--findings) | keep production deployment out of scope or design a separate hardened service | `confirmed` | Resolved |
| F023 | [Enforce product validation in every consumer workflow](#f023) | [product-config.md](./product-config.md#known-issues--findings) | require the validator in every build/release consumer or provide a reusable runtime validator | `confirmed` | Resolved |
| F024 | [Validate the default character package exists](#f024) | [product-config.md](./product-config.md#known-issues--findings) | add a package-existence CI check or startup smoke | `confirmed` | Resolved |
| F025 | [Use the shared ProductConfig type for WebDev bootstrap](#f025) | [product-config.md](./product-config.md#known-issues--findings) | type product as the shared readonly ProductConfig shape | `confirmed` | Resolved |
| F026 | [Include brand changes in fork identity detection](#f026) | [product-config.md](./product-config.md#known-issues--findings) | include brand-license identity in generic change detection | `confirmed` | Resolved |
| F027 | [Align icon validation with its static type](#f027) | [product-config.md](./product-config.md#known-issues--findings) | reject undefined dynamically or make omission part of the type | `confirmed` | Resolved |
| F028 | [Contain product icon paths within the repository](#f028) | [product-config.md](./product-config.md#known-issues--findings) | require a normalized relative path contained under repository root | `confirmed` | Resolved |
| F029 | [Validate updateFeedUrl during product validation](#f029) | [product-config.md](./product-config.md#known-issues--findings) | validate optional string/URL policy in product config before packaging | `confirmed` | Resolved |
| F030 | [Generate attribution before packaging](#f030) | [product-config.md](./product-config.md#known-issues--findings) | make attribution generation an explicit packaging prerequisite/dependency | `confirmed` | Resolved |
| F033 | [Complete the protocol type facade](#f033) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | export aliases for every public registered endpoint type | `confirmed` | Resolved |
| F035 | [Validate domain event payloads at consuming boundaries](#f035) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | retain explicit producer/consumer guards or introduce a discriminated event registry | `confirmed` | Resolved |
| F036 | [Enforce protocol cross-field relationships](#f036) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | verify each relationship in the owning package/handler validator before acceptance | `needs reproduction` | Resolved |
| F037 | [Reject empty response identifiers](#f037) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | add non-empty constraints where empty is not a meaningful wire value | `confirmed` | Resolved |
| F038 | [Enforce security policy beyond shape validation](#f038) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | enforce policy at owning handler/storage boundaries | `confirmed` | Resolved |
| F039 | [Review weak collection and record bounds](#f039) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | reproduce realistic limits, then add bounds where input is untrusted | `needs reproduction` | Resolved |
| F043 | [Align tdai reporting defaults](#f043) | [tdai-core.md](./tdai-core.md#known-issues--findings) | align documentation/default deliberately | `confirmed` | Resolved |
| F044 | [Reconcile local embedding configuration](#f044) | [tdai-core.md](./tdai-core.md#known-issues--findings) | either expose local mode with dependency/download policy or remove it from the external contract | `confirmed` | Resolved |
| F046 | [Canonicalize tdai store cache keys](#f046) | [tdai-core.md](./tdai-core.md#known-issues--findings) | canonicalize dataDir before caching and reset only after close | `confirmed` | Resolved |
| F047 | [Clarify the tdai integration export surface](#f047) | [tdai-core.md](./tdai-core.md#known-issues--findings) | expose the intended integration API or explicitly own resolved configuration in the host adapter | `confirmed` | Resolved |
| F048 | [Validate TCVDB model dimensions](#f048) | [tdai-core.md](./tdai-core.md#known-issues--findings) | validate model output dimensions before deployment/index creation | `needs reproduction` | Resolved |
| F049 | [Recover incomplete background L0 indexing](#f049) | [tdai-core.md](./tdai-core.md#known-issues--findings) | provide observable reindex/retry and do not treat capture counts as final vector completeness | `confirmed` | Resolved |
| F053 | [Align artifact and IPC sender checks](#f053) | [desktop.md](./desktop.md#known-issues--findings) | make referrer admission exact or preserve current navigation invariants with tests | `confirmed` | Resolved |
| F054 | [Define staged-update apply and cleanup lifecycle](#f054) | [desktop.md](./desktop.md#known-issues--findings) | define installer/cleanup lifecycle before presenting automatic updates | `confirmed` | Resolved |
| F057 | [Use the adopted message version in ResultSpace](#f057) | [companion-ui.md](./companion-ui.md#known-issues--findings) | share the adopted-version selection helper | `confirmed` | Resolved |
| F060 | [Make ambient media dismissal authoritative](#f060) | [companion-ui.md](./companion-ui.md#known-issues--findings) | add an authoritative Host dismissal/stop transition or document re-presentation | `confirmed` | Resolved |
| F061 | [Do not mask unrelated ResultSpace context errors](#f061) | [companion-ui.md](./companion-ui.md#known-issues--findings) | catch only the expected missing-context error | `confirmed` | Resolved |
| F062 | [Avoid empty or synthetic media captions](#f062) | [companion-ui.md](./companion-ui.md#known-issues--findings) | expose real captions when available and avoid rendering empty track sources | `confirmed` | Resolved |
| F071 | [Clarify model-expression suppression lifetime](#f071) | [host-runtime.md](./host-runtime.md#known-issues--findings) | clarify desired lifetime and reset at the matching turn boundary if per-turn behavior is intended | `needs reproduction` | Resolved |
| F073 | [Contain HF_ENDPOINT to runtime lifetime](#f073) | [host-runtime.md](./host-runtime.md#known-issues--findings) | avoid global mutation or restore the owned previous value safely | `confirmed` | Resolved |

### P3

| ID | Finding | Module reference | Next action | Confidence | Status |
| --- | --- | --- | --- | --- | --- |
| F002 | [Document transport rejection versus RPC failure](#f002) | [companion-client.md](./companion-client.md#known-issues--findings) | document and preserve the split at every transport boundary | `confirmed` | Resolved |
| F004 | [Align dispatcher registration documentation and behavior](#f004) | [companion-client.md](./companion-client.md#known-issues--findings) | align the comment and implementation, preferably validating registration | `confirmed` | Resolved |
| F008 | [Document host response-violation modes](#f008) | [companion-client.md](./companion-client.md#known-issues--findings) | document the host-specific mode wherever runtimes are constructed | `confirmed` | Resolved |
| F009 | [Keep request-only registry usage explicit](#f009) | [companion-client.md](./companion-client.md#known-issues--findings) | use RPC or CHANNEL_CONTRACTS for full metadata and retain the request-only warning | `confirmed` | Resolved |
| F011 | [Preserve runtime catalog parity checks](#f011) | [i18n.md](./i18n.md#known-issues--findings) | keep the catalog parity test mandatory or add a static shape constraint | `confirmed` | Resolved |
| F020 | [Document persistent manual WebDev state](#f020) | [web-dev.md](./web-dev.md#known-issues--findings) | keep this explicit in developer guidance and use the override when isolation is required | `confirmed` | Resolved |
| F021 | [Treat WebDev diagnostics as intentionally lossy](#f021) | [web-dev.md](./web-dev.md#known-issues--findings) | retain the local-diagnostics framing or add acknowledged durable collection as a separate design | `confirmed` | Resolved |
| F032 | [Keep character branding outside product config](#f032) | [product-config.md](./product-config.md#known-issues--findings) | change defaultCharacterId and ship corresponding character content in fork workflow | `confirmed` | Resolved |
| F034 | [Make payload-versus-envelope validation explicit](#f034) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | keep transport helpers explicit about payload versus envelope and use IpcResponse(endpoint.response) | `confirmed` | Resolved |
| F040 | [Treat endpoint versioning as naming-only](#f040) | [protocol-schema.md](./protocol-schema.md#known-issues--findings) | preserve v1 compatibility and add new versioned channels for breaking changes | `confirmed` | Resolved |
| F042 | [Correct tdai pipeline timing comments](#f042) | [tdai-core.md](./tdai-core.md#known-issues--findings) | update comments to parser behavior without changing runtime timing implicitly | `confirmed` | Resolved |
| F055 | [Dispose desktop window hooks explicitly](#f055) | [desktop.md](./desktop.md#known-issues--findings) | retain and invoke the disposer on webContents destruction | `needs reproduction` | Resolved |
| F056 | [Correct single-instance lifecycle comments](#f056) | [desktop.md](./desktop.md#known-issues--findings) | consolidate comments around actual guard behavior | `confirmed` | Resolved |
| F058 | [Complete semantic color token coverage](#f058) | [companion-ui.md](./companion-ui.md#known-issues--findings) | migrate touched surfaces to existing semantic tokens rather than adding parallel colors | `confirmed` | Resolved |
| F059 | [Document hard desktop layout minimums](#f059) | [companion-ui.md](./companion-ui.md#known-issues--findings) | retain as a documented desktop constraint or design a separate responsive layout | `confirmed` | Resolved |
| F063 | [Define UI error-presentation ownership](#f063) | [companion-ui.md](./companion-ui.md#known-issues--findings) | document which layer owns each operation's error presentation | `confirmed` | Resolved |
| F064 | [Test shortcuts under application landmark semantics](#f064) | [companion-ui.md](./companion-ui.md#known-issues--findings) | accessibility-test each added shortcut against the existing application landmark | `confirmed` | Resolved |
| F075 | [Make moderation timeout coverage scheduler-tolerant](#f075) | [host-runtime.md](./host-runtime.md#known-issues--findings) | use fake timers or assert abort/fail-open behavior with scheduler tolerance instead of an exact wall-clock lower bound | `confirmed` | Resolved |

## Resolved findings

Every finding below is resolved. Each entry retains its original category, evidence, impact, next action, and confidence; the `Resolution` line records the implemented fix or final policy and the verification evidence. The full green gate (lint, typecheck, test:unit, build, test:e2e:web — 21 passed, 1 external live-model skipped) is the shared verification for all entries; findings additionally name the module-level suites that exercise their boundary. Per-module remediation detail is in [remediation-status.md](./remediation-status.md).

### Confirmed bugs

<a id="f001"></a>
### F001: Validate envelopes in the exported unwrap helper

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — packages/companion-client/src/unwrap.ts, unwrap
- **Evidence:** the exported helper accepts {ok:true} without validating data and malformed failures without validating error, despite its defensive comment.
- **Impact:** direct callers can receive undefined as a typed success or an unrelated generic failure
- **Next action:** validate the complete envelope or narrow the helper's documented/type contract
- **Confidence:** `confirmed`
- **Resolution:** resolved — `unwrap` now parses every result through the full shared envelope schema (`AnyEnvelope = IpcResponse(z.unknown())`): a typed success requires validated `data`, a failure requires a valid protocol error branch, and malformed envelopes throw a validation error instead of returning `undefined`. Verified by the green gate and by `packages/companion-ui/tests/generated-client-contract.spec.ts` (rejects malformed `{ok:true}` data) and `packages/companion-ui/tests/ipc-errors.spec.ts` (error-kind mapping through `unwrap`).

<a id="f005"></a>
### F005: Normalize handler-thrown protocol error kinds

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — Dispatcher catch path and IpcErrorKind
- **Evidence:** any thrown err.kind string is copied into the envelope although the protocol permits only five kinds.
- **Impact:** the client rejects the resulting malformed envelope instead of receiving a stable protocol failure
- **Next action:** allowlist/normalize handler error kinds before constructing the envelope
- **Confidence:** `confirmed`
- **Resolution:** resolved — `Dispatcher.normalizeHandlerError` (packages/host-runtime/src/dispatcher.ts) allowlists `IPC_ERROR_KINDS` and normalizes any thrown `err.kind` outside the five protocol kinds to a safe fallback before the envelope is constructed. Verified by the green gate and the error-kind mapping coverage in `packages/companion-ui/tests/ipc-errors.spec.ts`.

<a id="f013"></a>
### F013: Reconcile the source-language interpolation placeholder

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — canonStudio.sourceLanguage catalog entry and i18next interpolation configuration
- **Evidence:** this key uses {{language}} while configured delimiters are { and }.
- **Impact:** the placeholder may render literally or inconsistently
- **Next action:** reproduce the rendered string, then use the configured delimiter form if confirmed
- **Confidence:** `needs reproduction`
- **Resolution:** resolved — the catalog entries now use the configured delimiter form: `sourceLanguage: "Source language: {language}"` (en.ts) and `资料语言：{language}` (zh-CN.ts, zh-TW.generated.ts), matching the module's `{...}` interpolation configuration. Verified by the green unit gate (`packages/i18n/tests/catalogs.spec.ts` and `locale-runtime.spec.ts`).

<a id="f026"></a>
### F026: Include brand changes in fork identity detection

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — validate-product-config.mjs IDENTITY_FIELDS and brandLicense
- **Evidence:** brand-only identity changes can evade generic modified=true detection, although the upstream exact gate catches them.
- **Impact:** a fork can generate an untruthful modification declaration
- **Next action:** include brand-license identity in generic change detection
- **Confidence:** `confirmed`
- **Resolution:** resolved — `brandLicense` is part of the identity field set used by generic change detection (packages/product-config/src/index.ts identity union), so brand-only changes produce `modified=true` in the generic gate, matching the upstream exact gate. Verified by the green gate and `apps/desktop/tests/config/check-upstream-brand.spec.ts`.

<a id="f041"></a>
### F041: Enforce tdai recall and capture flags

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — TdaiCore.handleBeforeRecall and handleTurnCommitted
- **Evidence:** the facade invokes recall/capture without checking cfg.recall.enabled or cfg.capture.enabled.
- **Impact:** disabling these features in config does not stop them for unconditional hosts
- **Next action:** enforce flags in the facade entrypoints
- **Confidence:** `confirmed`
- **Resolution:** resolved — the facade entrypoints now gate on the configured flags: `handleBeforeRecall` returns an empty result when `cfg.recall.enabled` is false, and capture paths (recall-context and turn-capture hooks) return early when `cfg.capture.enabled` is false (packages/tdai-core/src/core/tdai-core.ts). Verified by the green unit gate.

<a id="f057"></a>
### F057: Use the adopted message version in ResultSpace

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — ConversationPanel MessageItem adoption and ResultSpace source summary
- **Evidence:** display uses adoptedVersion while ResultSpace uses versions.at(-1).
- **Impact:** result header can describe a non-visible message version
- **Next action:** share the adopted-version selection helper
- **Confidence:** `confirmed`
- **Resolution:** resolved — message display shares a hardened adopted-version selection (`adoptedVersionId` → adopted-flagged version → latest fallback, ConversationPanel.tsx), and the persistence contract guarantees the adopted version is the newest projected version: regenerate/edit flows un-adopt prior versions and insert the adopted version last (turn-pipeline regenerate, repository adoption), so `versions.at(-1)` on the trigger message equals the visible adopted content that ResultSpace summarizes. Covered by `packages/companion-ui/tests/result-space.spec.tsx` (source summary from the trigger message) and the regenerate/reload journeys in the green e2e gate.

<a id="f066"></a>
### F066: Capture turns in the active character namespace

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — runtime.ts onTurnCommitted namespaceFor
- **Evidence:** capture uses productConfig.defaultCharacterId while other memory helpers resolve active companion.
- **Impact:** turns after activation are stored under the wrong character namespace
- **Next action:** resolve active companion at commit time
- **Confidence:** `confirmed`
- **Resolution:** resolved — the `onTurnCommitted` sink resolves the active character at commit time via `characterLoader.getActiveCharacterId(db.orm, productConfig.defaultCharacterId)` instead of freezing the product default, and builds the memory `sessionKey` from that resolved companion (packages/host-runtime/src/runtime.ts). Covered by `packages/host-runtime/tests/composition-ownership.spec.ts` and the memory-journey e2e; verified by the green gate.

<a id="f067"></a>
### F067: Persist approved memory scope consistently

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — RPC.memory.candidateApprove
- **Evidence:** SQLite relationship entry uses suggestedScope while backend metadata uses decidedScope when supplied.
- **Impact:** the same approved memory has conflicting scopes in UI/persistence and recall
- **Next action:** persist the effective decided scope consistently
- **Confidence:** `confirmed`
- **Resolution:** resolved — `candidateApprove` computes one `effectiveScope = decidedScope ?? candidate.suggestedScope` and persists it consistently: `relationshipMemoryEntries.scope`, `memory_decisions.decidedScope`, and the backend `metadata: { scope }` all use the same effective value, with a compensating backend forget if the owned transition loses a race (packages/host-runtime/src/composition.ts). Verified by the green unit gate (memory suites).

<a id="f068"></a>
### F068: Verify memory candidates before rejection

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — memory.candidateReject
- **Evidence:** update may match no active pending candidate, but a memory_decisions row is inserted unconditionally.
- **Impact:** nonexistent, already-decided, or foreign candidate IDs create orphan decisions instead of not-found/conflict
- **Next action:** require a successful owned pending-row transition before inserting the decision
- **Confidence:** `confirmed`
- **Resolution:** resolved — `candidateReject` now verifies the candidate exists and is owned by the active companion (`not_found`), rejects non-pending state (`conflict`), and inserts the decision inside the same transaction as the owned pending→rejected row transition, throwing `conflict` when the transition changes zero rows (packages/host-runtime/src/composition.ts). Verified by the green unit gate.

### Contract mismatches

<a id="f006"></a>
### F006: Reconcile the store's missing-client contract

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — createCompanionStore, CompanionClient parameter, event loop, derivePresence
- **Evidence:** comments describe an absent client as unavailable/idle, but the client is required and invoked unconditionally, and unavailable maps to problem.
- **Impact:** maintainers can code against a nonexistent missing-client mode
- **Next action:** either implement the mode end to end or remove/correct the contract text
- **Confidence:** `confirmed`
- **Resolution:** resolved — the contract text now states the truth: `createCompanionStore` requires a fully constructed `CompanionClient` and there is no supported missing-client or degraded-client mode (packages/companion-ui/src/stores/companion.tsx header). The stale unavailable/idle fiction was removed. Verified by the green gate and the store/IPC contract suites.

<a id="f012"></a>
### F012: Guard locale values at runtime

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — setProductLocale
- **Evidence:** the public function relies only on ProductLocale typing and accepts arbitrary strings at untyped boundaries.
- **Impact:** unsupported values can be persisted and applied to html/i18next
- **Next action:** perform the existing locale membership check inside the public function
- **Confidence:** `confirmed`
- **Resolution:** resolved — `setProductLocale(locale: unknown)` now performs the `isProductLocale` membership check at runtime and rejects unsupported values before any persistence or `html/i18next` application; `isProductLocale` is exported as a public guard (packages/i18n/src/index.ts). Verified by the green unit gate (`packages/i18n/tests/locale-runtime.spec.ts`).

<a id="f017"></a>
### F017: Validate WebDev bootstrap responses at the boundary

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — loadBootstrap and createHttpTransport
- **Evidence:** bootstrap JSON is cast without runtime validation and successful transport JSON is returned unvalidated until later client/UI paths.
- **Impact:** unexpected proxy responses fail far from the boundary
- **Next action:** validate bootstrap immediately and keep endpoint-envelope validation at the companion client boundary
- **Confidence:** `confirmed`
- **Resolution:** resolved — `loadBootstrap` validates the bootstrap immediately (rejects malformed ProductConfig-compatible payloads, empty tokens, and non-boolean debug flags before renderer startup) and HTTP failures use the dedicated `WebDevHttpError` while network/JSON parse rejections pass through; successful RPC envelope validation remains at the companion client boundary (apps/web-dev server and http-client). Verified by the green e2e gate (settings/env-contract journeys).

<a id="f025"></a>
### F025: Use the shared ProductConfig type for WebDev bootstrap

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — apps/web-dev/src/http-client.ts, WebDevBootstrap.product
- **Evidence:** server returns full ProductConfig including updateFeedUrl, but the static client type ends at icon.
- **Impact:** current UI is unaffected, but typed bootstrap consumers see an incomplete contract
- **Next action:** type product as the shared readonly ProductConfig shape
- **Confidence:** `confirmed`
- **Resolution:** resolved — WebDev bootstrap parsing now goes through the shared product-config validator (`parseWebDevBootstrap`), so the product contract (including `updateFeedUrl` and the signed-feed policy shape) is typed and checked before the browser trusts the bootstrap. Verified by the green gate and the e2e onboarding/settings journeys.

<a id="f027"></a>
### F027: Align icon validation with its static type

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — ProductConfig.icon type and dynamic validator
- **Evidence:** TypeScript requires string|null while validation accepts undefined.
- **Impact:** typed and dynamic consumers disagree on accepted config
- **Next action:** reject undefined dynamically or make omission part of the type
- **Confidence:** `confirmed`
- **Resolution:** resolved — the dynamic validator now rejects an `undefined` icon the same way the static type does, so typed and dynamic consumers agree on accepted configuration. Verified by the green gate and `apps/desktop/tests/config/validate-product-config.spec.ts`.

<a id="f029"></a>
### F029: Validate updateFeedUrl during product validation

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — ProductConfig.updateFeedUrl and generic validator
- **Evidence:** no runtime type or scheme validation occurs until update checking.
- **Impact:** malformed configuration fails late
- **Next action:** validate optional string/URL policy in product config before packaging
- **Confidence:** `confirmed`
- **Resolution:** resolved — the product-config validator now checks the optional `updateFeedUrl` policy at validation time (including rejecting non-HTTPS feed URLs) before packaging rather than failing at update-check time. Verified by the green gate and the product-config validator suites.

<a id="f033"></a>
### F033: Complete the protocol type facade

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — packages/protocol/src/index.ts exports versus schema.ts/RPC
- **Evidence:** many registered request/response types are not re-exported, including run interrupt/resume and artifact read/url requests.
- **Impact:** type-only consumers must import runtime schema internals
- **Next action:** export aliases for every public registered endpoint type
- **Confidence:** `confirmed`
- **Resolution:** resolved — the type facade now re-exports inferred aliases for every registered endpoint's request/response payload and domain type; `check-rpc-contracts.mjs` verifies each facade `z.infer` target resolves against `schema.ts` and that every endpoint channel is versioned and unique (packages/protocol/src/index.ts). A type-only consumer can name every registered endpoint type through `@bear-harness/protocol`. Verified by the green gate.

<a id="f037"></a>
### F037: Reject empty response identifiers

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — provider/model/commission/run/artifact response IDs
- **Evidence:** several base response schemas allow empty strings while related requests often require non-empty IDs.
- **Impact:** response validation can accept unusable identities
- **Next action:** add non-empty constraints where empty is not a meaningful wire value
- **Confidence:** `confirmed`
- **Resolution:** resolved — provider/model/commission/run/artifact response IDs, `ActionDraft.hash`, `draftHash`, `pluginHash`, artifact `sha256`, and audit hashes now reject empty strings in the base response schemas (packages/protocol/src/schema.ts). Verified by the green gate.

<a id="f043"></a>
### F043: Align tdai reporting defaults

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — ReportConfig comment and parseConfig
- **Evidence:** interface says reporting defaults enabled, parser resolves false.
- **Impact:** integrations can infer the wrong reporting state
- **Next action:** align documentation/default deliberately
- **Confidence:** `confirmed`
- **Resolution:** resolved — the `ReportConfig` documentation now states the actual default: `Enable reporting (default: false; privacy-safe until explicitly enabled)`, matching the parser's resolution (packages/tdai-core/src/config.ts). Verified by the green unit gate.

<a id="f044"></a>
### F044: Reconcile local embedding configuration

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — EmbeddingConfig, parseConfig, createEmbeddingService
- **Evidence:** internal local embedding exists but user config rewrites local to none with configError.
- **Impact:** advertised configuration cannot activate the implementation
- **Next action:** either expose local mode with dependency/download policy or remove it from the external contract
- **Confidence:** `confirmed`
- **Resolution:** resolved — `parseConfig` now keeps `provider="local"` in the resolved config as explicit offline node-llama-cpp mode; the runtime is bundled as a production dependency, and a native-load failure is reported while callers degrade to keyword search. The `configError` rewrite of local→none was removed (only qclaw missing-field validation still disables with a recorded error) (packages/tdai-core/src/config.ts). Verified by the green unit gate.

<a id="f047"></a>
### F047: Clarify the tdai integration export surface

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — tdai-core package root exports
- **Evidence:** parseConfig and concrete stores/embedding classes are omitted despite the facade expecting resolved config.
- **Impact:** consumers use internal imports or duplicate resolution, increasing sync coupling
- **Next action:** expose the intended integration API or explicitly own resolved configuration in the host adapter
- **Confidence:** `confirmed`
- **Resolution:** resolved — the package root now exports `parseConfig`, `VectorStore`, `TcvdbMemoryStore`, `createEmbeddingService` (and their config types), so integrations use the public surface instead of internal imports or duplicated resolution (packages/tdai-core/src/index.ts). Verified by the green unit gate.

<a id="f060"></a>
### F060: Make ambient media dismissal authoritative

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — ambient roleplay media dismissal
- **Evidence:** renderer clears only its active ID and sends no Host stop RPC.
- **Impact:** snapshots/events can re-present media the Host still reports
- **Next action:** add an authoritative Host dismissal/stop transition or document re-presentation
- **Confidence:** `confirmed`
- **Resolution:** resolved — the store now invokes the Host RPC `client.roleplay.dismissMedia({ conversationId, mediaId })` on dismissal (with operation-error retention) instead of only clearing the renderer's active ID, and the authoritative `roleplay.media_dismissed` event is projected (packages/companion-ui/src/stores/companion.tsx). Host media presentation/dismissal is the single source of truth. Verified by the green unit gate (roleplay presentation suites) and the e2e journeys.

<a id="f070"></a>
### F070: Reconcile executor profile contracts

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — ExecutorProfileType/PROFILE_TYPES versus SQLite executor_profiles constraint and registered controllers
- **Evidence:** router accepts native-full but schema permits only product-managed/codex.
- **Impact:** native-full cannot be persisted or resolved
- **Next action:** remove the unsupported type or migrate/register it end to end
- **Confidence:** `confirmed`
- **Resolution:** resolved — the unsupported `native-full` type was removed end to end: `ExecutorProfileType` is now `"product-managed" | "codex"`, the router validates against `PROFILE_TYPES`, and migration 19 rebuilds `executor_profiles` with a CHECK constraint that excludes `native-full`, dropping any legacy rows (packages/host-runtime/src/executors/router.ts, storage/database.ts). Verified by the green unit gate (`packages/host-runtime/tests/executor-controls.spec.ts` and `executor-adapters.spec.ts`).

### Security risks

<a id="f015"></a>
### F015: Keep the broad WebDev token strictly local

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev /bootstrap token and authenticated RPC/debug routes
- **Evidence:** any loopback client can obtain one bearer token authorizing the full surface, with no user/capability split.
- **Impact:** any local process can invoke all dev-host operations
- **Next action:** retain strict loopback/dev-only deployment and add stronger auth before any broader exposure
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, retained and enforced — the broad-but-strictly-local token model is the final policy: the server rejects non-loopback listen overrides and refuses production/public-listen intent (`WebDev Host is a loopback-only development harness; public or production listening is not supported`), and no broader exposure or user/capability split is introduced. Verified by the green gate and the e2e env-contract journey.

<a id="f028"></a>
### F028: Contain product icon paths within the repository

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — product icon path validation
- **Evidence:** the validator resolves paths against repo root but does not reject absolute paths or traversal before resolution.
- **Impact:** untrusted configuration could read/package an unintended file
- **Next action:** require a normalized relative path contained under repository root
- **Confidence:** `confirmed`
- **Resolution:** resolved — icon path validation now requires a normalized relative path contained under the repository root, rejecting absolute paths and traversal before resolution. Verified by the green gate and the product-config validator suites.

<a id="f031"></a>
### F031: Add publisher authentication before enabling updates

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings), [desktop.md](./desktop.md#known-issues--findings) — desktop packaging, update feed, UpdateService, product update guidance
- **Evidence:** packages are unsigned, staged updates lack signature/notarization verification, and sha256:null can bypass digest verification. This deduplicates desktop finding 1 and product-config finding 9 while retaining both evidence sources.
- **Impact:** a checksum or ready state does not authenticate a publisher
- **Next action:** add code-signing/notarization verification and authenticated update metadata before enabling a public feed
- **Confidence:** `confirmed`
- **Resolution:** resolved — update metadata is now publisher-authenticated (Ed25519-verified feed metadata) and every archive is SHA-256 verified against the signed, HTTPS-fetched metadata; `sha256: null` is rejected. The remaining platform trust gate — code-signing/notarization of the downloaded executable — is documented as a fork-side requirement before treating `ready` as installable, and a public feed is not enabled without it (apps/desktop/src/main/update-service.ts, packages/product-config). Covered by `apps/desktop/tests/update-service.spec.ts`; verified by the green gate.

<a id="f038"></a>
### F038: Enforce security policy beyond shape validation

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — provider/settings URL, credential and import fields
- **Evidence:** schemas bound size only; they do not enforce URL scheme/host policy, redaction, authorization, or encryption.
- **Impact:** unsafe destinations or secret leakage remain possible if handlers assume schema validation is sufficient
- **Next action:** enforce policy at owning handler/storage boundaries
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy — schema validation is explicitly shape-only (bounded size), and URL scheme/host policy, secret redaction, authorization, and encryption are enforced at the owning handler/storage boundaries (Host handlers own path/network/credential policy; the schema error comment prohibits leaking secrets). This split is documented in protocol-schema.md. Verified by the green gate.

<a id="f039"></a>
### F039: Review weak collection and record bounds

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — unbounded records and theme strings
- **Evidence:** multiple records have no entry cap and theme strings omit shared maximums.
- **Impact:** untrusted package data can consume more memory/work than common bounds imply
- **Next action:** reproduce realistic limits, then add bounds where input is untrusted
- **Confidence:** `needs reproduction`
- **Resolution:** resolved — `z.record` fields (onboarding answers, visual expressions/labels, draft files, character-runtime projections, roleplay values) are capped at 100 entries through the shared `boundedRecord` helper; theme strings remain unbounded but are documented as package-authored display values, not wire-critical inputs (packages/protocol/src/schema.ts). Verified by the green gate.

<a id="f045"></a>
### F045: Harden standalone workspace path containment

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — standalone llm-runner resolveSandboxedPath
- **Evidence:** startsWith lacks a separator boundary and symlinks are not resolved.
- **Impact:** a sibling prefix path or in-workspace symlink can escape workspaceDir through tool-enabled runs
- **Next action:** resolve real paths and verify containment with a path-relative/boundary-safe check
- **Confidence:** `confirmed`
- **Resolution:** resolved — `resolveSandboxedPath` now rejects absolute input paths, realpaths the workspace root, verifies containment with a boundary-safe `isContained` check (not string prefix), resolves symlinks before read access, and rejects symlinks for write access (packages/tdai-core/src/adapters/standalone/llm-runner.ts). Verified by the green unit gate (`packages/host-runtime/tests/security-fs-protection.spec.ts` covers the boundary policy).

<a id="f050"></a>
### F050: Require integrity for production update archives

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — UpdateService sha256 contract
- **Evidence:** explicit sha256:null reaches ready without digest verification.
- **Impact:** archive integrity is absent unless another authenticated trust layer exists
- **Next action:** disallow null for production feeds or require publisher authentication
- **Confidence:** `confirmed`
- **Resolution:** resolved — every feed entry now requires a `sha256` checksum: `undefined`/`null` entries are rejected at staging, the value must match `^[0-9a-f]{64}$`, and the downloaded archive's digest is verified against it (`verifySha256`) before any ready state; publisher-authenticated metadata bounds the trust chain (apps/desktop/src/main/update-service.ts). Covered by `apps/desktop/tests/update-service.spec.ts`; verified by the green gate.

<a id="f051"></a>
### F051: Require HTTPS for production updates

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — UpdateService.stage
- **Evidence:** both http and https archive URLs are accepted, including downgrade from an HTTPS feed.
- **Impact:** network attackers can alter an unauthenticated archive
- **Next action:** require HTTPS before production staging
- **Confidence:** `confirmed`
- **Resolution:** resolved — `stage()` rejects non-HTTPS download URLs and the product-config validator rejects non-HTTPS `updateFeedUrl` values, so HTTP archives and feed downgrades are refused (apps/desktop/src/main/update-service.ts, packages/product-config). Covered by `apps/desktop/tests/update-service.spec.ts`; verified by the green gate.

<a id="f052"></a>
### F052: Address Linux plaintext credential fallback

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — Linux safeStorage/CredentialStore fallback
- **Evidence:** unavailable safeStorage writes raw UTF-8 credentials marked weak_storage.
- **Impact:** provider secrets are plaintext at rest
- **Next action:** surface this state to users/security policy and require stronger storage where plaintext is unacceptable
- **Confidence:** `confirmed`
- **Resolution:** resolved — the plaintext fallback is removed: when safeStorage is unavailable or the Linux backend is weak (`basic_text` or non-libsecret/kwallet), the vault reports session-only security and the CredentialStore keeps provider secrets in memory and writes **no credential blob**; `weak_storage` is reserved for actual machine-local encrypted vaults such as WebDev's AES-GCM vault (apps/desktop/src/main/electron-credential-vault.ts, packages/host-runtime/src/providers/credential-store.ts). Covered by `apps/desktop/tests/electron-credential-vault.spec.ts` and `packages/host-runtime/tests/credential-store.spec.ts`; verified by the green gate.

<a id="f053"></a>
### F053: Align artifact and IPC sender checks

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — artifact-protocol.ts packaged referrer admission
- **Evidence:** IPC requires exact file URL, while artifact serving accepts any or empty file referrer.
- **Impact:** future local navigation paths would have broader artifact access than IPC
- **Next action:** make referrer admission exact or preserve current navigation invariants with tests
- **Confidence:** `confirmed`
- **Resolution:** resolved — artifact serving now requires the request referrer to match a registered window URL exactly (`isAllowedRendererReferrer` against the window registry), closing the any/empty-file-referrer asymmetry with IPC admission; navigation and window creation remain locked down (apps/desktop/src/main/artifact-protocol.ts, ipc-router.ts). Covered by `apps/desktop/tests/artifact-protocol.spec.ts`; verified by the green gate.

<a id="f069"></a>
### F069: Scope work records to the active companion

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — commission.list, run.list, snapshot.get
- **Evidence:** reads are not filtered/joined to active companion and snapshots include the broad lists.
- **Impact:** switching character packages can expose other characters' work records/artifacts
- **Next action:** scope lists and snapshot projections through active companion/conversation ownership
- **Confidence:** `confirmed`
- **Resolution:** resolved — `run.list` joins runs → commissions → conversations → messages and filters on `conversations.companionId = getCompanionId(s)`; `commission.list` uses `s.commissions.list({ companionId })`; `snapshot.get` resolves the active companion and scopes conversations, commissions, scene state, and character display through it (packages/host-runtime/src/composition.ts). Verified by the green unit gate (`packages/host-runtime/tests/composition-ownership.spec.ts` and commission suites).

### Reliability/operability risks

<a id="f003"></a>
### F003: Make Electron IPC registration lifecycle-safe

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — apps/desktop/src/main/ipc-router.ts, wireElectronIpcHandlers
- **Evidence:** each invocation calls ipcMain.handle for all channels and Electron rejects duplicate registration.
- **Impact:** repeated wiring in one process fails startup
- **Next action:** make lifecycle ownership single-shot or add an explicit registration guard/removal path
- **Confidence:** `confirmed`
- **Resolution:** resolved — the IPC router now removes a channel's previous handler before registering (`ipcMain.removeHandler(channel)` before `ipcMain.handle(channel, …)`), so repeated wiring is safe, and the returned disposer removes the handlers it owns on teardown (apps/desktop/src/main/ipc-router.ts). Covered by `apps/desktop/tests/ipc-router.spec.ts`; verified by the green gate.

<a id="f014"></a>
### F014: Surface locale storage and language-change failures

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — i18n module initialization and setProductLocale
- **Evidence:** localStorage calls are not guarded and init/changeLanguage promises are discarded.
- **Impact:** throwing storage or rejected language changes have no diagnostic/recovery path
- **Next action:** define failure handling at the module or application boundary
- **Confidence:** `confirmed`
- **Resolution:** resolved — storage access is guarded (optional-chained reads plus try/catch around persistence), and `setProductLocale` performs the locale membership check, persists within a guarded block, and applies the language change with an awaited, error-surfacing path so rejected changes are not silently discarded (packages/i18n/src/index.ts). Verified by the green unit gate (`packages/i18n/tests/locale-runtime.spec.ts`).

<a id="f016"></a>
### F016: Preserve WebDev request failure categories

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — apps/web-dev/server/index.ts RPC catch block
- **Evidence:** oversized bodies, malformed JSON, schema/dispatch exceptions, and other failures all become invalid json.
- **Impact:** operators lose the actual failure category
- **Next action:** distinguish body-limit, JSON parse, validation, and internal dispatch failures while preserving safe envelopes
- **Confidence:** `confirmed`
- **Resolution:** resolved — pre-dispatch failures are categorized at the HTTP boundary: body-limit, malformed JSON, channel decoding, unknown route/channel, authorization, and thrown internal/protocol failures each have distinct status/category pairs with fixed reasons; domain failures still resolve HTTP 200 with the original validated envelope so the client can distinguish RPC failure from transport rejection, and no exception details or request contents are returned (apps/web-dev/server/index.ts, WebDevHttpError). Verified by the green e2e gate (env-contract journey).

<a id="f018"></a>
### F018: Close WebDev port-selection races

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev availablePort, Rsbuild strictPort, rule-provider fixed port
- **Evidence:** port probing is check-then-bind and the provider uses a fixed port.
- **Impact:** another process can win the race or collide, causing startup/readiness failure
- **Next action:** bind atomically or add bounded retry/relocation where compatible with the test contract
- **Confidence:** `confirmed`
- **Resolution:** resolved — the dev launcher now uses bounded retry/relocation: up to 20 attempts over consecutive ports (skipping reserved ports), each verified by waiting for the child's bootstrap JSON on that port, with a fixed-port mode that fails fast with a clear error when the configured port is taken (apps/web-dev/scripts/dev.mjs `launchWithRetry`). Verified by the green e2e gate (boot/onboarding journeys).

<a id="f019"></a>
### F019: Clean process-scoped WebDev data directories

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev E2E process-scoped data directories
- **Evidence:** process scoping prevents state sharing, but launcher/Playwright never remove old .process-* directories.
- **Impact:** stale state and credentials accumulate under test-results
- **Next action:** remove scoped roots during orderly test teardown and retain failure artifacts only deliberately
- **Confidence:** `confirmed`
- **Resolution:** resolved — the dev supervisor now removes the process-scoped `.process-<scope>` root on orderly shutdown according to the `BEAR_WEB_DEV_DATA_CLEANUP` policy (`always` or `success`, i.e. success-only by default, preserving failure artifacts deliberately), with containment checks (scope regex, resolved parent match) before removal (apps/web-dev/scripts/dev.mjs `cleanupScopedData`, playwright.config.ts policy wiring). Verified by the green e2e gate and `apps/web-dev/server/data-directory.spec.ts`.

<a id="f024"></a>
### F024: Validate the default character package exists

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — defaultCharacterId validation and Host startup
- **Evidence:** syntax is checked but package existence is not; Host later throws for a missing package.
- **Impact:** a seemingly valid fork can fail startup
- **Next action:** add a package-existence CI check or startup smoke
- **Confidence:** `confirmed`
- **Resolution:** resolved — the desktop packaging wrapper validates the default character manifest (package existence) in addition to the shared syntax validator, so a missing character package is caught before release instead of at Host startup. Verified by the green gate and `apps/desktop/tests/config/product-config-validator.spec.ts`.

<a id="f036"></a>
### F036: Enforce protocol cross-field relationships

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — CharacterDisplay, roleplay and onboarding cross-field relationships
- **Evidence:** defaults and referenced IDs/types are not cross-validated by Zod.
- **Impact:** inconsistent package data can fail or misproject later
- **Next action:** verify each relationship in the owning package/handler validator before acceptance
- **Confidence:** `needs reproduction`
- **Resolution:** resolved — cross-field relationships are now enforced in the schema itself via `superRefine` refinements: `Message.adoptedVersionId`, character visual defaults/expression labels/unlockable media/variable initial/level minimums, onboarding text-step lengths, run/memory/canon timestamp and offset coherence, and record entry caps (packages/protocol/src/schema.ts). Handlers still enforce ownership and policy for referenced IDs. Verified by the green gate.

<a id="f046"></a>
### F046: Canonicalize tdai store cache keys

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — initStores cache in pipeline-factory.ts
- **Evidence:** raw directory strings are keys, so equivalent relative/absolute/symlink paths can open multiple stores over the same physical data.
- **Impact:** concurrent access and lifecycle confusion can corrupt or lock state
- **Next action:** canonicalize dataDir before caching and reset only after close
- **Confidence:** `confirmed`
- **Resolution:** resolved — `initStores` caches by a canonical physical directory: `canonicalDataDir` applies `path.resolve` plus `realpathSync.native` before the key is computed, so equivalent relative/absolute/symlinked paths resolve to one store (packages/tdai-core/src/utils/pipeline-factory.ts). Verified by the green unit gate.

<a id="f048"></a>
### F048: Validate TCVDB model dimensions

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — TcvdbMemoryStore dense index and tcvdb.embeddingModel
- **Evidence:** index dimensions are fixed at 1024 while model is configurable and config does not validate the relation.
- **Impact:** incompatible models can fail indexing/search
- **Next action:** validate model output dimensions before deployment/index creation
- **Confidence:** `needs reproduction`
- **Resolution:** resolved — TCVDB now carries known model dimensions (`bge-large-zh`/`bge-large-en`/`bge-m3` = 1024) and validates the configured `embeddingDimensions` against the selected model before index creation, rejecting the mismatch (`model emits X dimensions but tcvdb.embeddingDimensions is Y`); custom models must provide their dimension explicitly (packages/tdai-core/src/core/store/tcvdb.ts). Verified by the green unit gate.

<a id="f049"></a>
### F049: Recover incomplete background L0 indexing

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — deferred L0 embedding and TdaiCore.destroy
- **Evidence:** background indexing is best effort and shutdown waits only five seconds.
- **Impact:** successful capture can leave metadata-only rows/missing vectors
- **Next action:** provide observable reindex/retry and do not treat capture counts as final vector completeness
- **Confidence:** `confirmed`
- **Resolution:** resolved — failed deferred embeddings are retained with retryable metadata, and `TdaiCore` exposes idempotent `retryIndexing()` (retries only retained failures) and `reindexAll()` (rebuilds vectors from store text) so incomplete L0 indexing is observable and recoverable; capture counts are no longer treated as final vector completeness (packages/tdai-core/src/core/tdai-core.ts, auto-capture.ts). Verified by the green unit gate.

<a id="f055"></a>
### F055: Dispose desktop window hooks explicitly

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — createMainWindow/registerWindowHooks
- **Evidence:** returned disposer is discarded.
- **Impact:** unusual teardown may retain listeners even though normal Electron destruction cleans objects
- **Next action:** retain and invoke the disposer on webContents destruction
- **Confidence:** `needs reproduction`
- **Resolution:** resolved — `registerWindowHooks` disposers are retained per webContents and invoked both on `webContents.once("destroyed", …)` and during global teardown (apps/desktop/src/main/index.ts). Covered by `apps/desktop/tests/diagnostics/electron-wiring.spec.ts`; verified by the green gate.

<a id="f061"></a>
### F061: Do not mask unrelated ResultSpace context errors

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — WorkPanel optional ResultSpace helper
- **Evidence:** it catches every useResultSpace error rather than only missing-provider.
- **Impact:** unrelated provider/runtime defects are silently masked
- **Next action:** catch only the expected missing-context error
- **Confidence:** `confirmed`
- **Resolution:** resolved — `useResultSpace` now has exactly one throw path: the missing-provider error (`useResultSpace must be used within ResultSpaceProvider`), so the optional wrapper's catch can only intercept the expected missing-context case; any other provider/runtime defect surfaces normally. The isolation contract (components render without the provider) is pinned by `packages/companion-ui/tests/result-space.spec.tsx` and `work-run-controls.spec.tsx`; verified by the green gate.

<a id="f065"></a>
### F065: Make HostRuntime startup retry-safe

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — HostRuntime.start
- **Evidence:** started is set before fallible proxy/memory/character/supervisor steps, so later failure makes retries no-op.
- **Impact:** partial startup cannot recover on the same instance
- **Next action:** set started after success or track/roll back partial initialization
- **Confidence:** `confirmed`
- **Resolution:** resolved — `start()` commits `started` only after all startup work succeeds and rolls back its subscriptions, filesystem sentinels, supervisor bridge, and owned process environment on failure, so a partially failed start leaves the instance retryable (packages/host-runtime/src/runtime.ts). Verified by the green unit gate (host-runtime runtime suites).

<a id="f072"></a>
### F072: Remove the global Host bridge on teardown

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — CompanionSupervisor globalThis.bearHostCall
- **Evidence:** start installs the process-global function and stop does not remove it.
- **Impact:** callers retain a stale capability after runtime close
- **Next action:** uninstall or replace the bridge during stop with ownership checks
- **Confidence:** `confirmed`
- **Resolution:** resolved — the supervisor tags its bridge with a unique owner token and on teardown restores/removes only its own bridge (`if (hostGlobal.bearHostCall !== bridge) return;` before deleting or restoring the saved previous value), so callers cannot retain a stale capability and newer owners are preserved (packages/host-runtime/src/companion/supervisor.ts). Verified by the green unit gate.

<a id="f073"></a>
### F073: Contain HF_ENDPOINT to runtime lifetime

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — process.env.HF_ENDPOINT lifecycle
- **Evidence:** constructor mutates the process-global variable from persisted settings and close does not restore it.
- **Impact:** multiple runtimes affect each other's downloads and teardown leaves state behind
- **Next action:** avoid global mutation or restore the owned previous value safely
- **Confidence:** `confirmed`
- **Resolution:** resolved — the runtime saves the previous `HF_ENDPOINT` value on install and restores it on close only while its owned lease is still installed (`installHfEndpoint` lease guard), so multiple runtimes cannot clobber each other and teardown leaves the process environment as it was found (packages/host-runtime/src/runtime.ts). Verified by the green unit gate.

<a id="f075"></a>
### F075: Make moderation timeout coverage scheduler-tolerant

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — packages/host-runtime/tests/security-moderation.spec.ts, `ModerationService remote policy` timeout test
- **Evidence:** the test injects `timeoutMs: 20`, measures `Date.now()` around `checkText`, and requires elapsed time to be at least 20 ms; the root unit suite failed when elapsed time was 19 ms versus the required 20 ms, while the check returned the expected fail-open result.
- **Impact:** wall-clock scheduler precision can produce a nondeterministic CI failure and obscure otherwise valid moderation coverage; this is not evidence of a moderation timeout-policy failure.
- **Next action:** use fake timers or assert abort/fail-open behavior with scheduler tolerance instead of an exact lower wall-clock bound
- **Confidence:** `confirmed`
- **Resolution:** resolved — the timeout test now advances Vitest fake timers (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(20)`) and asserts the expected fail-open result, so coverage no longer depends on wall-clock scheduler precision (packages/host-runtime/tests/security-moderation.spec.ts). Verified by the green unit gate.

### Design limitations

<a id="f002"></a>
### F002: Document transport rejection versus RPC failure

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — HostTransport.invoke and apps/web-dev/src/http-client.ts
- **Evidence:** transport failures reject promises while RPC failures remain IpcEnvelope values.
- **Impact:** callers need two error paths and new transports can accidentally fabricate domain errors
- **Next action:** document and preserve the split at every transport boundary
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, documented — the split is the explicit contract at every transport boundary: transport failures reject promises (`web-dev transport failed: <status>`), RPC failures resolve as `IpcEnvelope` values, and the WebDev server preserves exact domain reasons over HTTP 200 while categorizing pre-dispatch failures separately; a new transport must document the same distinction rather than fabricating domain errors (companion-client.md, web-dev.md known-issues sections). Verified by the green gate.

<a id="f007"></a>
### F007: Define call cancellation and timeout ownership

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — HostTransport and CompanionClient lifecycle
- **Evidence:** there is no cancellation, timeout, retry, or idempotency key.
- **Impact:** long calls and polling inherit transport behavior, and naive retries can duplicate mutations
- **Next action:** define transport-specific timeout/cancellation behavior and do not retry mutations without an idempotency contract
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, documented — timeout/cancellation/retry are explicitly transport-owned: the client adds no timeout, cancellation, or retry policy, rejected transport failures pass through unchanged, and a transport must not retry mutations unless an endpoint-specific idempotency contract exists (companion-client.md known-issues section; client.ts contract header). Verified by the green gate.

<a id="f008"></a>
### F008: Document host response-violation modes

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — Dispatcher protocolViolationMode and clients
- **Evidence:** malformed response handling is Host configuration; WebDev throws while other hosts may isolate, and client validation occurs only after transport.
- **Impact:** environments expose different failure behavior
- **Next action:** document the host-specific mode wherever runtimes are constructed
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, documented — `protocolViolationMode` is documented as Host-runtime configuration: `HostRuntime` maps it to the dispatcher's explicit `responseValidation: "throw"` or `"isolate"` mode, both invoke `onProtocolViolation`, throw rejects with `ProtocolResponseValidationError` while isolate returns an `internal / response_validation_failed` envelope, and the client rejects malformed envelopes only after a transport resolves (companion-client.md known-issues section). Verified by the green gate.

<a id="f011"></a>
### F011: Preserve runtime catalog parity checks

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — packages/i18n/src/locales/en.ts and catalog parity test
- **Evidence:** English is not statically constrained to typeof zhCN; parity is discovered only by tests.
- **Impact:** omitted/extra keys survive typecheck
- **Next action:** keep the catalog parity test mandatory or add a static shape constraint
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, retained — the catalog parity test remains mandatory in the localization change loop (`packages/i18n/tests/catalogs.spec.ts`), which is the documented guard for English/zh-CN shape parity. Verified by the green unit gate.

<a id="f020"></a>
### F020: Document persistent manual WebDev state

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — webDevDataDirectory without BEAR_WEB_DEV_DATA_DIR
- **Evidence:** manual WebDev intentionally uses the persistent platform path shared with prior runs/Electron.
- **Impact:** manual sessions can observe existing product state
- **Next action:** keep this explicit in developer guidance and use the override when isolation is required
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, documented — manual WebDev persistence is the documented default: without `BEAR_WEB_DEV_DATA_DIR`, WebDev uses the platform data path shared with prior WebDev/Electron sessions; the override is the documented isolation mechanism, and process-scoped E2E data remains under `test-results` for deliberate failure diagnosis (web-dev.md known-issues section). Verified by the green gate.

<a id="f021"></a>
### F021: Keep WebDev renderer reporting non-blocking while persisting bounded local diagnostics

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — installRendererFaultReporting and diagnostics route
- **Evidence:** browser reporting is fire-and-forget; the Host validates allowlisted metadata and writes it through the shared local JSONL diagnostics system.
- **Impact:** renderer delivery can still be lost, but accepted records and business traces are durable and queryable on the same machine
- **Next action:** retain non-blocking renderer delivery, local-only storage, strict content/log-level policy, and trace export coverage
- **Confidence:** `confirmed`
- **Resolution:** resolved — renderer delivery remains fire-and-forget, while the Host persists validated metadata and end-to-end business traces locally. TRACE content is redacted and source-only; packaged apps clamp it off. Trace-id query/export is local and atomic, never telemetry. Verified by diagnostics contracts, integration tests, and the release gate.

<a id="f022"></a>
### F022: Do not deploy the WebDev host as production

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev build/server deployment
- **Evidence:** build emits renderer assets but does not package, supervise, authenticate, or deploy server/index.ts.
- **Impact:** treating it as production-ready would expose an inappropriate dev host
- **Next action:** keep production deployment out of scope or design a separate hardened service
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, documented — production deployment is prohibited: `build` produces browser assets only and does not bundle, supervise, authenticate, or deploy `server/index.ts`; the Host refuses production/public-listen intent and must never be exposed directly, through the UI proxy, or through a forwarding/shared proxy (web-dev.md known-issues section; server index.ts loopback guard). Verified by the green gate.

<a id="f032"></a>
### F032: Keep character branding outside product config

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — product-config asset boundary
- **Evidence:** only the shell icon is owned here; character visuals/copy remain in character packages.
- **Impact:** renaming product/icon alone does not create an independent brand
- **Next action:** change defaultCharacterId and ship corresponding character content in fork workflow
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, documented — the asset boundary is explicit: the official icon is the only product-config asset; a genuinely independent brand requires changing `defaultCharacterId` and shipping the corresponding character package (product-config.md known-issues section). Verified by the green gate and `apps/desktop/tests/config/check-upstream-brand.spec.ts`.

<a id="f034"></a>
### F034: Make payload-versus-envelope validation explicit

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — RPC endpoint response fields and IpcResponse
- **Evidence:** endpoint.response validates payload only; runtime envelope validation is a separate factory.
- **Impact:** transports can validate the wrong shape
- **Next action:** keep transport helpers explicit about payload versus envelope and use IpcResponse(endpoint.response)
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, documented — the payload-versus-envelope split is explicit: `RPC.*.response` is the payload validator, `IpcResponse` is a separate envelope factory, and `EnvelopeOf<E>` is documented as a type-only convenience that does not create a runtime envelope validator; transports must use `IpcResponse(endpoint.response)` (protocol-schema.md known-issues section). Verified by the green gate.

<a id="f035"></a>
### F035: Validate domain event payloads at consuming boundaries

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — DomainEvent.payload
- **Evidence:** payload is z.unknown and generic subscription cannot validate kind-specific shapes.
- **Impact:** malformed event payloads cross the generic boundary unless producers/consumers guard them
- **Next action:** retain explicit producer/consumer guards or introduce a discriminated event registry
- **Confidence:** `confirmed`
- **Resolution:** resolved — a known-event contract registry (`EventPayloadSchemas`) validates each known kind's payload at publish and renderer-consumption time; `DomainEvent` carries a bounded JSON payload (`BoundedEventValue`) and unknown forward-compatible kinds are accepted only as bounded opaque events, which remain bounded but untyped by design (packages/protocol/src/schema.ts). Covered by `packages/protocol/src/schema.memory.spec.ts` and the store's event projection guard; verified by the green gate.

<a id="f040"></a>
### F040: Treat endpoint versioning as naming-only

- **Module/path/symbol:** [protocol-schema.md](./protocol-schema.md#known-issues--findings) — :v1 endpoint versioning
- **Evidence:** versioning is naming-only with no negotiation, migration, or adapter.
- **Impact:** breaking changes require coordinated new channels and consumers
- **Next action:** preserve v1 compatibility and add new versioned channels for breaking changes
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, enforced — versioning is enforced by a gate: the `${string}:v1` endpoint constraint and channel strings communicate a version, and `check-rpc-contracts.mjs` detects duplicate or unversioned endpoint channels; a breaking change must be represented by a new channel/contract with coordinated consumers — there is still no migration or negotiation layer by design (protocol-schema.md known-issues section; check-rpc-contracts.mjs). Verified by the green gate.

<a id="f054"></a>
### F054: Define staged-update apply and cleanup lifecycle

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — UpdateService lifecycle
- **Evidence:** it stages version directories but never applies, rolls back, launches, or removes them.
- **Impact:** ready is not an installed update and disk use grows
- **Next action:** define installer/cleanup lifecycle before presenting automatic updates
- **Confidence:** `confirmed`
- **Resolution:** resolved — the staged-update lifecycle is explicit: verified archives are atomically finalized, stale/superseded data is retained only until deterministic cleanup, `update.discard:v1` removes staged data, and `update.apply:v1` reports `applyUnsupported: true`; `ready` never implies installation (apps/desktop/src/main/update-service.ts, packages/protocol/src/schema.ts). Covered by `apps/desktop/tests/update-service.spec.ts`; verified by the green gate.

<a id="f058"></a>
### F058: Complete semantic color token coverage

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — companion-ui styles.css theme tokens
- **Evidence:** literal Tailwind/rgba colors remain on multiple themed surfaces.
- **Impact:** character theme overrides are incomplete
- **Next action:** migrate touched surfaces to existing semantic tokens rather than adding parallel colors
- **Confidence:** `confirmed`
- **Resolution:** resolved — the theme token architecture is complete: styles.css defines companion semantic design tokens with semantic-role aliases consumed by the shell, thread, composer, work, and result UI surfaces, and touched surfaces were migrated to those tokens instead of adding parallel colors. Verified by the green unit gate (`packages/companion-ui/tests/shell-visual-contract.spec.tsx` and idle-home/fork-config landmark suites).

<a id="f059"></a>
### F059: Document hard desktop layout minimums

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — body and desktop shell CSS
- **Evidence:** 1050x680 minimums plus overflow hidden and only a 1200px adjustment prevent mobile/small embedding layouts.
- **Impact:** smaller windows clip rather than reflow
- **Next action:** retain as a documented desktop constraint or design a separate responsive layout
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, documented — the hard 1050x680 desktop minimums (with overflow hidden and the 1200px adjustment) are retained and documented as the desktop layout constraint; smaller windows clip rather than reflow by design, and a responsive layout would be a separate design (companion-ui.md known-issues section and desktop.md). Verified by the green gate.

<a id="f062"></a>
### F062: Avoid empty or synthetic media captions

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — artifact and roleplay media tracks
- **Evidence:** filename/full-duration synthetic captions or empty/undefined caption URLs are used.
- **Impact:** markup is not equivalent to real captions and may request an empty URL
- **Next action:** expose real captions when available and avoid rendering empty track sources
- **Confidence:** `confirmed`
- **Resolution:** resolved — audio/video roleplay and archive media now require real WebVTT captions: the schema rejects audio/video media without captions and the character loader validates the `.vtt` extension, so `captionsUrl` is a required, never-empty source for those tracks; artifact previews retain the documented synthetic full-duration data-URL track (always a `data:` URL, never empty) as accessible fallback markup (packages/host-runtime/src/companion/roleplay-schema.ts, character-loader.ts; ResultSpace.tsx). Verified by the green unit gate (roleplay presentation suites).

<a id="f063"></a>
### F063: Define UI error-presentation ownership

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — store/component error reporting
- **Evidence:** core errors use shared store state while supplementary methods reject to local handlers.
- **Impact:** new actions can fail without the expected alert if the wrong convention is chosen
- **Next action:** document which layer owns each operation's error presentation
- **Confidence:** `confirmed`
- **Resolution:** resolved — error-presentation ownership is defined and enforced: core store operations retain failures in shared state via `retainOperationError("<operation>", error)` (boot, memory, refresh, conversation, message, settings operations), while component-local actions present failures through their own handlers (`setActionError`), and the store contract documents that action failures "retain operation metadata without choosing a presentation surface" (packages/companion-ui/src/stores/companion.tsx, WorkPanel.tsx). Verified by the green unit gate (ipc-errors.spec.ts pins the localized presentation mapping).

<a id="f064"></a>
### F064: Test shortcuts under application landmark semantics

- **Module/path/symbol:** [companion-ui.md](./companion-ui.md#known-issues--findings) — root role=application and keyboard interactions
- **Evidence:** application semantics alter assistive-technology behavior around nested landmarks and shortcuts.
- **Impact:** new global shortcuts may conflict with screen-reader modes
- **Next action:** accessibility-test each added shortcut against the existing application landmark
- **Confidence:** `confirmed`
- **Resolution:** resolved — shortcuts are tested under the application landmark semantics: `packages/companion-ui/tests/sidebar-journey.spec.tsx` exercises Cmd/Ctrl+K inside a `role="application"` landmark (including a non-hijacking assertion for editing contexts), and the shell landmark suites (idle-home, fork-config, shell-visual-contract) cover the `role="application"` root. Verified by the green unit gate.

<a id="f071"></a>
### F071: Clarify model-expression suppression lifetime

- **Module/path/symbol:** [host-runtime.md](./host-runtime.md#known-issues--findings) — CharacterBehaviorService modelSelectedExpression
- **Evidence:** flag is cleared on message.user_sent, not message_end, so suppression is conversation state that spans completion until another user message.
- **Impact:** lifecycle reactions can be unexpectedly suppressed
- **Next action:** clarify desired lifetime and reset at the matching turn boundary if per-turn behavior is intended
- **Confidence:** `needs reproduction`
- **Resolution:** resolved — suppression is now current-turn state: the marker is consumed on every `message_end` (successful ends skip the mapped reaction once), failed ends clear the marker without applying `result_ready`, and aborts clear it before applying their configured reaction; user-sent also clears the marker for the next turn (packages/host-runtime/src/companion/character-behavior.ts; host-runtime.md known-issues item 7). Verified by the green unit gate (`packages/host-runtime/tests/character-behavior.spec.ts`).

### Documentation/tooling debt

<a id="f004"></a>
### F004: Align dispatcher registration documentation and behavior

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — Dispatcher.registerHandler documentation
- **Evidence:** the comment says unknown channels throw, but implementation only inserts endpoint.channel; rejection happens only during dispatch.
- **Impact:** typos or stale endpoints remain latent until invoked
- **Next action:** align the comment and implementation, preferably validating registration
- **Confidence:** `confirmed`
- **Resolution:** resolved — `registerHandler` now validates at registration time: it throws `TypeError` for malformed endpoints, `unknown RPC endpoint: <channel>` for channels absent from `CHANNEL_CONTRACTS`, and `duplicate RPC handler registration: <channel>` for duplicates, matching its documentation (packages/host-runtime/src/dispatcher.ts). Verified by the green unit gate (`packages/host-runtime/tests/dispatcher.spec.ts`).

<a id="f009"></a>
### F009: Keep request-only registry usage explicit

- **Module/path/symbol:** [companion-client.md](./companion-client.md#known-issues--findings) — REQUEST_SCHEMAS consumers
- **Evidence:** the map contains request schemas only and does not carry response or endpoint metadata.
- **Impact:** treating it as a complete registry creates incomplete clients/contracts
- **Next action:** use RPC or CHANNEL_CONTRACTS for full metadata and retain the request-only warning
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, documented — `REQUEST_SCHEMAS` remains explicitly request-only with its warning retained; full endpoint metadata comes from `RPC`/`CHANNEL_CONTRACTS`, and consumers use those for response and envelope contracts (protocol facade and dispatcher contracts). Verified by the green gate.

<a id="f010"></a>
### F010: Remove the locale generator's stale-dist hazard

- **Module/path/symbol:** [i18n.md](./i18n.md#known-issues--findings) — packages/i18n/scripts/generate-zh-tw.mjs, build/generate scripts, dist exports
- **Evidence:** standalone generation imports stale or absent dist, the supported build requires two tsc passes, and consumers resolve dist rather than source. This deduplicates the first three i18n entries without dropping their separate build-chain facts.
- **Impact:** copy can be missing or stale despite source edits
- **Next action:** make generation establish fresh input or enforce/document the full build sequence
- **Confidence:** `confirmed`
- **Resolution:** resolved — `generate-zh-tw.mjs` now imports the TypeScript source (`../src/locales/zh-CN.ts`) instead of `dist`, so standalone generation always uses fresh input, and the build sequence (compile → generate → compile) remains documented for consumers resolving `dist` (packages/i18n/scripts/generate-zh-tw.mjs). Verified by the green unit gate (`packages/i18n/tests/catalogs.spec.ts`).

<a id="f023"></a>
### F023: Enforce product validation in every consumer workflow

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — ProductConfig import/validation boundary
- **Evidence:** the package exports a plain typed object; validate-product-config.mjs runs only in external build/release workflows.
- **Impact:** new consumers can load invalid config
- **Next action:** require the validator in every build/release consumer or provide a reusable runtime validator
- **Confidence:** `confirmed`
- **Resolution:** resolved — the package now exports pure `validateProductConfig` and throwing `assertProductConfig` as reusable runtime validators, and the desktop packaging script (and upstream-brand check) validate before release; the import boundary documents that direct consumers of the plain constant should explicitly validate untrusted or alternate configuration (packages/product-config/src/index.ts, apps/desktop/scripts/validate-product-config.mjs). Verified by the green gate and `apps/desktop/tests/config/validate-product-config.spec.ts`.

<a id="f030"></a>
### F030: Generate attribution before packaging

- **Module/path/symbol:** [product-config.md](./product-config.md#known-issues--findings) — validate-product-config.mjs output and Electron Builder resources
- **Evidence:** packaging expects dist/brand/BRAND-ATTRIBUTION.txt, but only the validator write step creates it.
- **Impact:** skipping that step yields packaging failure or incomplete notices
- **Next action:** make attribution generation an explicit packaging prerequisite/dependency
- **Confidence:** `confirmed`
- **Resolution:** resolved by policy, enforced — generated attribution is an explicit packaging prerequisite: the validator's write step produces `dist/brand/BRAND-ATTRIBUTION.txt` and Electron Builder copies it into the package (`{ from: attributionPath, to: "BRAND-ATTRIBUTION.txt" }`), with the dependency documented so skipping the step is a known packaging failure rather than silent incompleteness (apps/desktop/electron-builder.config.ts, product-config.md known-issues section). Verified by the green gate.

<a id="f042"></a>
### F042: Correct tdai pipeline timing comments

- **Module/path/symbol:** [tdai-core.md](./tdai-core.md#known-issues--findings) — PipelineConfig comments versus parseConfig
- **Evidence:** comments state 60s/90s while resolved defaults are 600s/10s.
- **Impact:** operators can tune or diagnose against wrong timing
- **Next action:** update comments to parser behavior without changing runtime timing implicitly
- **Confidence:** `confirmed`
- **Resolution:** resolved — the pipeline timing comments now match parser behavior: L1 idle timeout documented as default 600s and L2 delay as default 10s (plus the 900s min / 3600s max L2 intervals), with no runtime timing change (packages/tdai-core/src/config.ts). Verified by the green unit gate.

<a id="f056"></a>
### F056: Correct single-instance lifecycle comments

- **Module/path/symbol:** [desktop.md](./desktop.md#known-issues--findings) — packaged single-instance comments
- **Evidence:** adjacent comments describe per-data-dir and per-install behavior while code is app.isPackaged-gated.
- **Impact:** maintainers can change E2E/dev identity based on incorrect prose
- **Next action:** consolidate comments around actual guard behavior
- **Confidence:** `confirmed`
- **Resolution:** resolved — the single-instance comments are consolidated around the actual `app.isPackaged` guard and `BEAR_E2E_APP_DATA` handling; the duplicated per-data-dir/per-install prose was removed so maintainers rely on the real behavior (apps/desktop/src/main/index.ts; desktop.md known-issues section). Verified by the green gate.

### Resolved-during-documentation observations

These observations were already resolved at documentation time; they are retained with their original evidence and their current resolution state. No open work item remains.

<a id="f074"></a>
### F074: WebDev E2E runs no longer share process state

- **Module/path/symbol:** [web-dev.md](./web-dev.md#known-issues--findings) — WebDev E2E data isolation
- **Evidence:** the module reference explicitly states process-scoped directories now prevent concurrent runs from sharing state, addressing the earlier readiness/state-isolation failure mode.
- **Impact:** the concurrency defect is resolved; only cleanup accumulation remains open as a separate finding
- **Next action:** retain the process-scope unit coverage and do not reopen this item absent regression evidence
- **Confidence:** `confirmed`
- **Resolution:** resolved — process-scoped data isolation (`BEAR_WEB_DEV_DATA_DIR`/`BEAR_WEB_DEV_DATA_SCOPE` per launcher process) is covered by `apps/web-dev/server/data-directory.spec.ts` and the e2e isolation journeys. The separate cleanup finding this observation originally deferred ([F019](#f019-clean-process-scoped-webdev-data-directories)) is **also resolved**: the dev supervisor now removes `.process-<scope>` roots on orderly teardown under the `BEAR_WEB_DEV_DATA_CLEANUP` policy, so both the isolation defect and the cleanup accumulation are closed. Verified by the green e2e gate.
