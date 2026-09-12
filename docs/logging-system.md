# Logging system implementation status

## Scope and ownership

This implementation now includes recording, diagnostic search, segmented export,
incident retention, renderer observations, memory batch/embedding/storage spans,
acquisition measurements, and failure-path tests. Verification boundaries and
remaining release qualification are explicit below; catalog declarations are
not counted as instrumented execution.

Pi remains authoritative for execution, messages, queues, branches and settlement.
`CharacterTrace` holds diagnostic span handles only. Nothing reads diagnostic files
to reconstruct a Pi session or to drive a product lifecycle. External Run events
come from the real executor observer and the existing Run service; diagnostics do
not decide Run outcomes. Audit retains its existing independent hash chain.

Installation policy is stored in `system/settings.db`, in `diagnostics_settings`.
New databases declare the table in the final schema; existing current-schema
installations create this additive feature table without changing existing rows.
The policy cache is installation-owned and remains readable during shutdown after
the database closes. Policy changes go through validated RPC and audit as config
changes. System and character writers use the same level/retention settings.

## Implemented paths

- Host RPC entry/return/failure, using a new trace per request; diagnostic queries
  do not recursively record their own returned logs. RPC bodies are not copied
  wholesale, so provider configuration does not become a credential-bearing log.
- Real Pi agent start/settlement, tool spans and native events. Model failures are
  ERROR; automatic retry start is WARN; token deltas are TRACE. Only deltas are
  stored between message boundaries, not a full growing snapshot on every token.
- Actual compiled per-session and per-turn context, under the character's root.
- Host publication of Pi events (publication is not claimed to prove UI rendering).
- Memory recall, capture, both searches, model input/output/failure and upstream
  logger messages with original levels/text. The old separate rotating memory
  writer has been replaced, not retained as a second live sink.
- Executor events, authoritative Run changes and result delivery, with explicit
  Run/conversation identifiers. Run-id-derived traces retain correlation across
  executor recovery; delivery records also carry the Run id.
- Existing system startup/RPC/renderer-fault/crash diagnostics and existing Audit
  continue. The system character-content entry point was removed. Packaged builds
  honor TRACE instead of silently clamping it to DEBUG.
- Renderer receipt/projection duration, observed native sequence, scroll distance,
  and fault-triggered recent metadata. Batches are limited to 128 observations;
  pending overflow and transport failure are counted and reported. A renderer id
  distinguishes windows. Every conversation id is checked against Host ownership.
  `projected` means the reactive projection function returned, **not GPU paint**.
  Fault message/stack is a character-local payload governed by full/metadata
  policy and credential filtering; system fault reporting stays metadata-only.
  Oversized fault details are rejected and counted, not silently truncated.
- TDAI L1/L2/L3 scheduled batches, store initialization/persistence, single/batched
  embeddings and sandboxed memory file tools. Batch spans parent model calls and
  carry the scheduler input. Bear supplies optional diagnostic observation through
  the HostAdapter; no memory scheduling or checkpoint authority moves to Bear.
- Installation embedding acquisition phases, fetch status/duration, download
  completion/failure/bytes and state-file persistence. These system measurements
  contain no role text, credentials, arbitrary URL or model file content. Failure
  measurements use ERROR rather than being hidden under DEBUG.

## Record and storage contract

Character records carry schema version, event/launch/process ids, sequence, UTC
time, owner, trace/span/parent ids, level, event, scoped ids and attributes. Span
durations use a monotonic clock. Payload recording policy is explicit per record.
Errors preserve type/message/stack/cause. Native settlement is `settled`, not an
invented successful model result. Open spans at shutdown are marked interrupted.

```text
system/diagnostics/                 operational metadata and native crash data
companions/<id>/diagnostics/
  traces/<traceId>/events.jsonl     append-only observed diagnostic events
  traces/<traceId>/payloads/       credential-filtered, SHA-256-addressed JSON
  traces/<traceId>/incident.json  first ERROR/FATAL evidence reference
  traces/<traceId>/pinned         explicit retention protection
  search.db                      rebuildable search metadata, no Pi transcript
  metrics/<launchId>.json          atomic writer-health/clean-shutdown snapshot
companions/<id>/audit/             existing independent audit chain
```

Ordinary conversation text, queries, paths and model context are retained in full
mode. Credential fields, authentication tokens, password assignments and private
key blocks are filtered. This is not a guarantee against every conceivable secret
embedded in arbitrary prose: exports must still be reviewed before sharing.
No uploads or automatic screenshots are introduced. Existing historical logs are
not deleted or retroactively converted.

The writer uses an asynchronous queue bounded at 500 queued records / 16 MiB.
Records that exceed the queue bound are rejected and counted, not silently
truncated. File writes use owner-only creation modes and no-follow file opens;
trace directories are validated as real directories. Event appends and payload
writes are synced. Writer-health snapshots use a synced temporary file and rename.
Write failure cannot fail the model/tool operation; health exposes drops/failures.

Default policy: DEBUG + full content, 30 days and 200 MiB per character/system
diagnostic root. Settings provide level, full/metadata, retention presets and a
15-minute TRACE override (Host accepts no more than one hour). Retention runs on
activity at most once a minute, deletes whole traces, and protects live spans and
observed active Runs. This is a soft retained-data target: live traces can exceed
it. Lowering the level or retention does not rewrite existing records.

Explicitly pinned traces are also protected. Up to 20 recent incidents receive
retention priority for up to seven days, within 25% of the configured trace byte
budget; an oversized incident is not silently exempted from quota. Historical
metrics have age retention and a separate 10%-of-trace-budget allowance (minimum
64 KiB); the current launch snapshot is protected. The SQLite index is a derived
cache and is not included in the trace byte quota.

Character events include the system launch id when supplied by the app shell,
so native crash/process-gone records can be associated without copying role
content to system logs. A previous unclean launch with a confirmed dead pid
produces an incident on the next write. PID reuse can prevent this inference;
it is not claimed to replace the native crash reporter.

Shutdown has a two-second deadline. A stalled writer rejects shutdown rather
than falsely acknowledging a clean flush; a caller must not remove its directory
after that failure. Native filesystem I/O cannot be cancelled after submission,
so it may finish later. Only completed flushes persist a clean marker.

## Settings and export

System Settings → Logs and diagnostics provides policy controls, current writer
health, paginated traces, exact event/conversation filtering, an error/incident
filter, pin/unpin controls, expandable events and checksum-verified payloads.
RPC search also accepts level and run id. Each event page is bounded at 200
records and approximately 1 MiB (a record is never split).

Search metadata uses SQLite only at the existing database boundary. It indexes
trace id/time/event/level/conversation/run identifiers, not messages or lifecycle
state. Startup rebuilds it from JSONL; a missing or corrupt disposable index can
be rebuilt without modifying the evidence. Search pagination uses time + id,
not unstable directory order. Live appends also update an open index.

Desktop reveal takes only `system | character | memory | latest`, resolved by Host from its
trusted runtime layout. Renderer paths are never accepted. WebDev does not show
a non-working native reveal button; it provides trace downloads.

The UI downloads segmented JSONL: each line is a bundle with `events`, verified
`payloads`, `byteRange` and writer evidence. Export fixes the source end offset on
its first request, so an active trace cannot extend it forever. Each segment has
at most 200 events / 16 MiB of referenced payload, with byte-boundary cursors.
This removes the former whole-trace 8/32 MiB limit from the UI workflow. Browser
Blob assembly still requires memory proportional to the export. The bounded
single-JSON RPC remains available for small diagnostic consumers.

Completeness describes **observed records**, not proof of exhaustive coverage or
successful execution. Per-launch metrics include bounded operation counts, sum,
maximum and duration buckets at 10/100/1000/10000/60000 ms and above. They are not
an application-wide CPU/GPU profiler or an HTTP packet capture.

## Memory correctness fix

Error/aborted model messages now reject the TDAI model call instead of becoming
empty successful text. Non-JSON, syntactically invalid and semantically malformed
scene/memory fields reject; a valid `[]` remains
a successful empty result. Failed/partially failed L1 extraction does not advance
the checkpoint. Already-written items may be encountered again after a partial
failure; existing deduplication remains authoritative, with duplicate risk if
deduplication is disabled. This does not attempt to
recover previously consumed cursors automatically.

## Qualification still outstanding / limits

- Native packaged smoke on fresh platform packages and a clean release commit;
  source Electron tests are not equivalent to packaged verification.
- Multi-hour pressure/retention runs, real full-filesystem faults, and OS-level
  permanently stalled device tests. Unit tests inject ENOSPC and stalled flush;
  a >8 MiB trace test exercises the real paginated filesystem/export path.
- Generic HTTP packet-level instrumentation, GPU paint/layout profiling, and
  OS-wide filesystem tracing are not implemented. Current measurements cover
  the concrete product operations enumerated above.
- Renderer observations are TRACE except faults/loss evidence. The recent
  renderer buffer cannot survive a hard process crash without delivery; native
  process-gone evidence remains available. No screenshot or automatic upload is
  introduced.
- A pin can intentionally exceed normal retention. Search cache space and browser
  export Blob memory are separate from the configured retained trace quota.

## Verification and release decision

Four new production modules: `CharacterTrace` (1004 lines), `DiagnosticsSettings`
(433 lines), browser download (15 lines), renderer observations (77 lines):
1529 production lines. Six new test files total 745 lines. The diagnostic SQLite
boundary adds approximately 95 lines inside the existing database module.
Integration changes span Host composition/storage/executors/memory, protocol,
system shells, UI/settings, and three locale catalogs. Counts exclude unrelated
pre-existing UI edits in the dirty worktree and are not a claim about their scope.

- Repository typecheck, including both app shells: passed.
- Host unit suite: 544 passed, 4 skipped (67 files).
- TDAI unit suite: 8 passed (2 files).
- UI full unit suite with two workers: 251 passed, 1 skipped (35 files). An earlier
  parallel run hit one timing-budget failure; no timing threshold was relaxed.
- Browser E2E on isolated ports/data with the local rule provider: passed real Pi tracing, Settings mutation,
  temporary TRACE controls, event filtering, durable pin/unpin, payload viewing
  and segmented downloaded bundle checks, including credential-filtered
  character-local renderer fault payloads.
- Desktop production build and two source Electron diagnostic E2Es passed:
  Host-resolved system/character/memory/latest directory commands (native shell
  call intercepted) and an actual renderer crash/process-gone record. The
  system-directory command follows the app's actual diagnostic root, including
  test/startup overrides. These do not claim fresh platform package verification.
- Settings screenshot inspected and button styling corrected; UI design-language
  gate and `git diff --check` passed.
- Full lint passed through test-quality/RPC/boundary checks, then stopped at the
  existing, unchanged `config/characters/volibear/character.yaml`: `state_schema`
  is not a recursive object JSON Schema. That unrelated package was not modified.

Release decision: **not release-ready**. This is an uncommitted implementation
checkpoint in an already dirty worktree, not completion of all observability
work or release gates. No release, package, signature or clean-commit attestation
is produced. The user's running development Host was not forcibly restarted.
