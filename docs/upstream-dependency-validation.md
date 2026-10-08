# Upstream dependency validation

Bear tests the upstream interfaces it actually calls and updates dependency groups independently. A green version proposal means the candidate commit passed the complete CI matrix; installation or compilation alone is insufficient.

## Coverage and ownership

`config/upstream-contracts.json` registers all 68 direct external npm dependencies across 12 groups. Lint rejects an unregistered dependency or a missing evidence file. Internal workspace packages are tested as Bear code. Transitive packages are resolved in the lockfile and checked through their parent interfaces, security audit, signatures, builds and packaged smoke; this is not a claim of testing every transitive API.

| Group | Acceptance boundary |
| --- | --- |
| Pi | Real AgentSession, real OpenAI HTTP/SSE transport, streaming, abort, provider errors, reopen, tool registration and non-persistent per-turn context; existing Registry concurrency/lifecycle tests |
| ACP | Real installed Codex adapter stdio handshake, SDK protocol, existing executor permissions, cancellation and result handling |
| Memory | Real AI SDK HTTP, embedding request/response validation, shared installation embedding configuration; real GGUF inference, SQLite vector index, semantic ordering, Jieba and real BM25 document/query sparse vectors |
| Storage | Real SQLite/Drizzle, transactions, queue scheduling, cancellation, file locks |
| Formats | YAML, JSON Schema/AJV, JSON Patch, Zod and Studio schema fields |
| Files | Real Unicode ZIP round trips, package archive import, DOCX-to-Markdown, assets and media metadata |
| Rendering | Existing Markdown, code highlighting, math, sanitizer and bounded rendering tests |
| UI | Real Solid reactivity, query isolation/cancellation, Kobalte controls; browser virtualization and conversation workflows |
| Localization | Language conversion and locale changes without resetting the runtime store |
| Desktop | Electron build/IPC/E2E, ASAR, native bindings, four platform packages and packaged smoke |
| Toolchain | Actual lint/parser, typecheck, tests, coverage, web/desktop builds and browser execution |

The dedicated suite adds 77 tests, including 27 updater/merge tests and 5 native tests. It reuses existing regressions rather than cloning them. The earlier estimate of 144 scenarios was a planning estimate, not an implemented-test count. `test:upstream` currently runs 261 test cases, with zero pending/skipped tests; the 5 native cases run separately on each native CI target.

The local HTTP fixtures replace remote servers, not Pi, the AI SDK, undici or ACP. These contracts verify wire behavior without spending model tokens or requiring CI credentials. They do not establish live-model character quality.

## Upgrade adaptations

- Pi 1.1 stores stable system messages natively. Bear accepts that native format and uses `context_with_system` for temporary Canon, memory and Character/Display context prepared in `before_agent_start`. Tests verify the context reaches the request but never becomes a transcript entry. No parallel transcript is introduced.
- Native system entries remain in Pi snapshots but are excluded from the visible conversation timeline. The regression verifies both ownership and presentation. Virtualized history uses Bear's existing follow/load-older anchor without competing native end anchoring; real browser checks cover pagination and story resume after reload.
- Pi built-in MCP discovery and codemode remain outside the Bear-managed tool set. Explicit Bear tools remain authoritative for the product boundary.
- Remote embeddings reject wrong dimensions, missing outputs and duplicate indexes before indexing. Valid out-of-order responses are restored to input order.
- Babel 8 parsing enables JSX only for `.tsx` in the RPC checker, so ordinary TypeScript generic syntax remains valid.
- The Registry heap test clears Vitest's retained mock-call contexts before measuring garbage collection. Its existing heap thresholds and resource-disposal assertions are unchanged.
- Node/npm versions are declared once in the root manifest and `.nvmrc`; every CI installation selects the declared npm version.
- PortableGit version, URL and SHA-256 are centralized. Git for Windows 2.56 uses `ucrt64`; staging, notice collection, startup PATH and packaged verification use that layout.

KaTeX remains at 0.18.5 because marked-katex-extension 5.1.13 declares a peer range excluding 0.19.0. Its next candidate remains an independent failing rendering PR until compatible. The existing Drizzle 1.0 RC constraint is not downgraded to the older stable release. No forced peer resolution is used.

## Automatic updates

`.github/workflows/upstream-update.yml` runs daily at 03:23 UTC and supports manual dispatch. It proposes 12 dependency groups plus infrastructure separately, including stable major releases. Infrastructure includes Node, npm, Actions, PortableGit and explicit transitive overrides. No external bot installation is needed. Updating GitHub workflow files requires a repository-scoped `UPSTREAM_WORKFLOW_TOKEN` secret with Contents and Workflows write permissions (and Actions write for dispatch). GitHub does not grant workflow-file editing to its default `GITHUB_TOKEN`. PR creation and candidate dispatch still use the default bot identity. Ordinary npm and binary updates use the default token when the optional secret is absent; an Action upgrade fails visibly until that permission is configured.

Each group starts from current main, updates every workspace using its dependencies and creates a fresh lockfile in an isolated directory without lifecycle scripts. Resolution failures still leave a PR, with failing installation, for inspection. Unchanged groups do not create duplicate PRs; infrastructure also refreshes transitives. Branches are `codex/upstream-<group>`.

The updater explicitly dispatches candidate CI because bot-created pushes must not be assumed to recursively trigger validation. CI checks lint, types, every unit suite, interface contracts without skips, coverage thresholds, security audit and signatures, recovery, required Web E2E, Electron E2E, builds and all four native package/smoke targets.

The merge workflow executes its verifier from main, without installing candidate dependencies. It requires a successful bot-dispatched run for the same repository and exact PR head, every required job and all four package jobs. Only version changes are accepted: no source/test edits, workflow logic changes, added dependencies or new lifecycle-script permissions. A non-forced Git ref update promotes exactly the tested commit, atomically rejecting a main branch that acquired untested commits. It then dispatches CI on main. The next daily proposal rebases any other group that became stale; it never merges the stale result.

Repository rules remain effective. Actions must be enabled and permitted to create PRs and write contents. A permission failure is a failed automation, never a reason to bypass repository settings. CI must have access to npm, GitHub, Chromium/Electron downloads and the pinned embedding fixture. Missing binaries, failed downloads or unsupported native bindings fail the candidate.

## Local verification

Run all commands through the selected toolchain:

```sh
fnm exec --using=.nvmrc npm ci
fnm exec --using=.nvmrc npm run test:upstream
fnm exec --using=.nvmrc npm run build:packages
fnm exec --using=.nvmrc npm run test:upstream:native
fnm exec --using=.nvmrc npm run test:ci -- --list
```

The native suite downloads the fixed embedding fixture into `.cache/upstream` and checks its SHA-256. `BEAR_UPSTREAM_MODEL` may point to an existing copy with that exact hash. CI executes it on macOS arm64/x64, Linux x64 and Windows x64.

To inspect a candidate locally, use `npm run upstream:update -- <group>`, select the resulting `.nvmrc` version, install the declared npm, then `npm run upstream:lock` and `npm ci`. The `all` group is available for a coordinated manual upgrade.

## 2026-10-08 engineering validation

Baseline: `7feab742ed3c9353c6799c1a48a4e61b4a646bd2`; macOS arm64, Node 26.11.1 / npm 12.2.0.

Scope: 9 workspace packages plus root dependency/CI infrastructure; 53 files. Excluding the regenerated lockfile, the patch adds 2,726 lines and removes 175. The lockfile replaces 14,799 lines with 10,808 lines. Pi owns native conversation state; Host owns per-session context injection; UI owns filtering and scrolling; TDAI validates embedding boundaries; the trusted CI verifier owns automatic promotion.

- Clean installation: 0 known audit vulnerabilities; 840 verified registry signatures and 314 verified attestations.
- Lint, typecheck, upstream contracts and real native contracts: passed.
- Complete unit suite: 1,349 passed, 3 platform/GC-dependent skips; these skips remain distinct from the no-skip upstream gate.
- Coverage passed unchanged thresholds: Host 79.94% statements / 70.09% branches; UI 81.91% / 70.70%; Desktop 86.18% / 76.08%.
- Recovery: 75 tests passed. Desktop and Web builds passed. Production Crashpad smoke generated a real crash dump successfully.
- Electron: 4 source E2E tests passed. A fresh macOS arm64 DMG/ZIP passed package-boundary and native-binding checks and its packaged startup smoke (1 test).
- Web required/local visual suite: 95 passed, 2 optional live scenarios skipped. This includes Studio, 10,000-entry virtualized history, 500 conversation switches, 60 seconds of streaming and all 21 responsive screenshot baselines without baseline changes.
- Live identity/memory validation: blocked by repeated upstream HTTP 503 responses from the configured `gpt-5.6-sol` route. The run was stopped after preserving original native user/error messages in `docs/evaluations/upstream-2026-10-08-live-transport.json`; no character-quality pass is claimed and Studio live validation remains unverified.

Release decision: this change does not constitute a public release. Four-platform CI, fresh packages and clean-commit evidence must pass before release acceptance. Live-model character acceptance is a separate real-model gate and is not replaced by the local wire fixtures.

Deployment prerequisite: the local GitHub browser session is signed out and the available GitHub connector does not expose repository Actions permission/secret administration. This task cannot verify or provision `UPSTREAM_WORKFLOW_TOKEN` or the repository's Actions PR-creation setting. Configure these in repository Settings; do not put credentials in the repository or chat. This limitation is separate from local test results.

## Clean-checkout CI correction

CI run `37727272013` stopped during lint: `check-canon-packages.mjs` imports the compiled Host CharacterLoader, but the quality job had not built workspace packages. Local build output masked this missing prerequisite. Root `prelint` now runs `build:packages`, so both local and CI lint build the exact current source before validating Canon; the check is not skipped or weakened.

Verified in a separate fresh checkout at `c5614ee` with this fix applied: no Host `dist` or build cache existed before installation; a fresh `npm ci` followed by `npm run lint` passed, including all three Canon documents. The correction changes one script entry and this report; it does not change product/runtime ownership. Full remote CI remains the release authority.

The next Linux run passed lint/typecheck and exposed a separate unit-fixture leak: the character-consent test configured `https://example.invalid` for embeddings, which now also starts real background Canon indexing. Host teardown correctly waited for active embedding work and exceeded the test hook's timeout. The fixture now serves deterministic embeddings on a local ephemeral HTTP port, kept alive until Host shutdown finishes. Consent/isolation assertions and timeouts are unchanged; no product cleanup or network failure behavior is bypassed. Scope/shared-embedding regressions (7 cases) pass.
