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

## CI performance correction (2026-10-08)

The audit read all 23 job logs (16,371 lines) from runs `37729184755` and `37739005347`. The latter green run at `6781008` took 12m20s, with macOS Intel packaging on the critical path (647s), Windows packaging 576s, Web E2E 508s and quality 261s. Job durations overlap and must not be added to estimate elapsed time.

- In the first optimization, each consuming job built shared workspaces once in dependency order. `BEAR_SHARED_BUILT=1` reuses only outputs from that checkout; `build:packages` always forces a build. Standalone local lint/typecheck/build still prepare their dependencies. No generated application output or `node_modules` is cached across commits.
- In the first optimization, package and Electron E2E jobs built the desktop application only. Web development and the quality build reuse the shared outputs. Windows child build tools use the selected Node/npm without shell argument interpolation.
- `release-gate` and the dependency-free upstream brand check disable both explicit and implicit setup-node npm caches. Brand checking no longer installs the monorepo. Other installs retain the lockfile cache, use offline cache entries when available, and disable install-time audit; the independent security job still audits vulnerabilities and signatures.
- Downloads are cached separately: Electron, electron-builder tools, verified PortableGit, the SHA-256-verified embedding fixture and Chromium. Chromium installation excludes the unused headless shell. Cache keys separate OS/architecture, and current downloads retain their integrity checks. Installer upload uses compression level 0 because the files are already compressed.
- Native binding verification runs once per packaged target, after packaging. A downloaded embedding fixture is renamed to the canonical cache path after SHA verification, avoiding repeated Hugging Face resolution. Model preparation, hashing and runtime warmup are timed separately.
- Required Web E2E uses two isolated single-worker shards under the existing required job. Ports, provider processes, runtime directories, output directories and reports are separate. Every shard must pass; missing reports and nonzero exit codes fail the job. `test-results/web-dev/timings.json` and the Actions summary contain per-test timings.
- Deterministic streaming tests release a provider response after observing the relevant UI state instead of waiting 4/8 seconds. Their cleanup releases held responses even after a failed assertion. The endurance workload retains its intentional latency simulation. No production timing is changed.
- The 10,000-entry capacity fixture still uses valid 100-entry native history pages. Setup clicks keep the history control focused so virtualization retains it, and skip remote pointer-stability waits while checking the button is enabled and each page actually arrives. Dedicated native-pagination E2E retains normal browser clicks, anchor checks and refresh coverage. Capacity, focus, 500 switches and heap/latency limits are retained.
- Four design-language viewport checks share one onboarding/conversation setup. Full responsive navigation journeys remain. Provider configuration tests now prepare their own prerequisites. A focus assertion explicitly targets the assistant article, avoiding a matching accessibility notification.
- Upstream updater/merge Node tests run once in the upstream gate, rather than also in remaining unit tests. Root `test:unit` includes that upstream gate. Recovery tests remain independently runnable and included in coverage: removing either would weaken a required gate for only a few seconds of actual test work.
- Successful Electron journeys discard their trace archive; failed journeys retain it and diagnostics. Packaged smoke has its own output directory so it cannot erase Web or source-Electron evidence during local validation. Package logs distinguish Electron preparation, app assembly, each installer/archive, boundary checking and native checking.

Compression comparison used the same assembled application payload and electron-builder's 7z archive path locally (concurrent validation was running, so elapsed values are indicative, not runner guarantees):

| Format | Default level / seconds / bytes | Level 5 / seconds / bytes |
| --- | --- | --- |
| ZIP | 7 / 32.58s / 447,731,527 | 5 / 10.71s / 450,174,256 |
| 7z (NSIS payload codec) | 9 / 138.75s / 245,759,610 | 5 / 55.50s / 273,729,153 |

Windows uses level 5 for ZIP/NSIS: the benchmark trades approximately 0.55%/11.38% larger archives for less compression work. Level 3 was rejected for the NSIS path because its benchmark payload grew about 40%. macOS keeps electron-builder's native ZIP path, which preserves framework symlinks; these 7z results are not presented as macOS installer measurements. Windows packaging and smoke must pass on its native CI runner.

Remaining observations are not silently treated as fixed defects: runner apt installation is necessary confinement/Electron setup; npm cannot reuse native installed dependencies across platforms; transitive deprecated `inflight`, `rimraf`, `glob` and `node-domexception` come from pinned upstream toolchains and remain visible pending compatible upstream updates. No unverified overrides were added. Expected Linux DBus/EGL messages and the intentional Crashpad crash are retained in diagnostics. Optional live-model/platform/GC skips remain distinct from the no-skip upstream contracts. This optimization does not confer live-model acceptance or authorize a public release.

Local validation before pushing this correction: lint and all workspace typechecks passed; remaining unit suites (93 tests), updater/merge tests (29), no-skip upstream contracts (234), Host coverage (709 passed, 2 platform/GC skips), UI coverage (312 passed, 2 skips), Desktop coverage (207), recovery (75), and native embedding/binding contracts (5) passed. Coverage thresholds were unchanged (Host 79.94% statements / 70.08% branches; UI 81.91% / 70.70%; Desktop 86.18% / 76.08%). Security found zero vulnerabilities and verified 840 registry signatures / 314 attestations. Required Web passed 70 tests with 2 optional live skips in 102.9s across two shards; merging four viewport setups accounts for the three fewer test cases, with all four width assertions retained. The 10,000-entry fixture took 7.0s and rendered 29 rows. Four source Electron journeys, actual Crashpad smoke, fresh Mac arm64 DMG/ZIP, package boundary/native verification and packaged smoke passed. A final Mac packaging run took 37.18s: Electron preparation 2.50s, application assembly 12.67s, ZIP 21.32s and DMG 13.43s (the archive targets overlap). Cross-platform and warm-cache timing remain CI evidence, not claims derived from this machine. Product ownership and runtime behavior are unchanged; this is CI/build/test-infrastructure work, not a release approval.

The first all-platform run after this change, `37749424691` at `ed522b1`, passed every job and the final gate. End-to-end elapsed time was 11m39s versus 12m20s before; this first run populated the new caches. Jobs: Intel Mac 594s (previous 647s), Windows 440s (576s), Mac ARM 324s (347s), Linux 288s (358s), Web 402s (508s), quality 183s (261s), Electron 93s (146s), brand 13s (38s), final gate 14s (19s). Shared-runner installation variance offset some savings: preflight was 64s versus 63s and recovery 64s versus 46s. Intel Mac remains the critical path: 97s installation, 107s application assembly, and overlapping ZIP/DMG generation of 83s/91s. No larger end-to-end saving is claimed from overlapping job savings. Successful Electron diagnostics shrank to 4,985 bytes.

Review of that run found one remaining DEP0190 warning in Windows SBOM generation. The follow-up invokes `cmd.exe` with fixed command text and `shell: false`, preserving the pinned npm and all SBOM options; platform invocation tests and actual local SBOM generation passed before pushing. The Web report runner also removes each old shard report before launch so a missing fresh report cannot reuse stale evidence; both isolated shards were exercised locally. A subsequent full CI run must validate this follow-up and demonstrate cache hits.


## Shared build and installer optimization (2026-10-08)

The next change moves all shared workspace compilation and the desktop main/preload/renderer build into preflight. The same-run `shared-build-${{ github.sha }}` artifact carries a tar payload plus commit, lockfile digest, Node/npm identity, payload SHA-256, and per-file hashes. Consumers restore and validate it after their native dependency installation. Export rejects native binaries, symlinks and `node_modules`; restore replaces old generated directories and validates executable permissions on Unix. Platform-specific Electron/native dependencies, package assembly, Crashpad, packaged smoke, platform architecture checks, hashes and SBOM remain on their native runners. Quality builds the Web application; it does not compile the desktop again. Nothing is reused from another commit.

DMG retains its existing compression settings. DMG `writeUpdateInfo` and NSIS `differentialPackage` are disabled because Bear's update service verifies full downloads using signed feed metadata and SHA-256; it does not consume electron-updater blockmaps. Mac ZIP uses the same native `zip -7 -y` behavior, preserving framework symlinks and executable modes, without generating a blockmap. ZIP creation starts when the finalized application enters DMG/NSIS artifact generation, and packaging cannot succeed before it finishes. Windows uses the builder's pinned, checksum-verified 7zip tool at level 5. A bounded-concurrency hard-link snapshot fixes Windows ZIP directory entries before NSIS adds its elevation helper; existing signed payload bytes are not copied or changed. ZIP failures propagate and partial ZIP/snapshot resources are removed.

Evidence behind the estimate remains run `37749424691`: Intel Mac packaging 230s, with parallel ZIP/DMG tails of 35.73s/33.35s after blockmap generation begins; Windows installer blockmap tail 14.25s and sequential ZIP 52.72s before NSIS 126.09s. Removing both Mac blockmaps suggested approximately 33s less critical-path work, not 69s. Windows parallelism has a 53s theoretical ceiling before resource contention and snapshot overhead. Shared compilation removes 42s from Intel's platform job but adds common build/transfer time before consumers. These figures are estimates, not achieved CI savings; no DMG compression saving is claimed.

Local validation: shared-build round-trip, stale-output replacement, commit/lock/toolchain mismatch, archive/file corruption, and native-payload exclusion contracts passed. A real Mac ZIP retained framework links and executable permissions; the Windows archive path passed a real 7zip integrity check with a Unicode filename. Lint and all workspace typechecks passed. Desktop coverage passed all 212 tests and its unchanged thresholds (86.18% statements, 76.08% branches). Fresh Mac ARM DMG/ZIP generation took 35.45s locally: Electron preparation 2.01s, assembly 9.50s, overlapping ZIP 14.91s and DMG 22.92s. Boundary and native-binding checks, full ZIP/DMG integrity verification, and packaged application startup smoke passed. This local timing is not comparable to the hosted Intel runner and is not evidence of a 33s CI improvement.

Ownership remains entirely build/release infrastructure; no Host, Pi, character or updater behavior changes. Native Windows/Linux and Intel Mac packaging still require the single post-push CI run. Release decision: no public release approval; existing live-model and release gates remain required.

Engineering change count: 3 infrastructure areas (shared build transport, installer generation, CI contracts/evidence), 13 files, 534 added lines and 57 removed lines. Remaining unit suites passed 97 tests. No product runtime modules changed.
