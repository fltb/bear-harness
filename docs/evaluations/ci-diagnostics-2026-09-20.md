# CI diagnostic timeout investigation — 2026-09-20

Base: `49dfa187016a0871a391550129e866816aeb36c8`. Local macOS, Node 24.19.0.
No new CI run, release tag, or publication was triggered during this investigation.

## Reproduction and scope

- The full hosted-profile Web suite reproduced the diagnostic timeout locally: 66 passed, 2 skipped, 1 failed. The failure remained after restricting the query to the new Session, disproving the earlier claim that query scoping alone was sufficient.
- The failed Session's original JSONL contained both `pi.agent_end` and `pi.agent.end`. This was not a missing model response.
- Reopening its retained diagnostic directory and querying the exact Session/event took 5199.69 ms cold and 0.33 ms warm. The test's default 5000 ms poll conflated cold history replay with visibility of a newly emitted event.
- A small synthetic 2000-record directory took only 316.61 ms. Small isolated tests therefore did not reproduce the accumulated full-suite condition.
- The public CI summaries were accessible, but authenticated failure attachments were not. The local reproduction establishes a real defect; it does not prove every detail of the original Linux failure.

## Changes

1. Rebuild the disposable character-local SQLite search index in batches of at most 200 rows, rather than one commit per historical record. Transactions are synchronous and never span filesystem awaits. Failure rolls back the batch and propagates; original JSONL evidence is unchanged.
2. Initialize the index before sending the diagnostic probe and assert that the fresh Session has no completed event. The existing 5-second poll then measures new-event visibility. The entire journey retains its existing 60-second deadline.
3. Retain explicit Session/event filtering and paginated original-record inspection. Add deterministic coverage for the default 100-trace window, bounded replay batches, rollback, and subsequent live writes.

Pi remains authoritative for conversation execution. No Pi state is reconstructed or persisted by this change. The index is derived diagnostic metadata only, physically character-local.

## Measurements and limitations

On the same retained failure directory, the initial batched replay measured 2366.87 ms versus the original 5199.69 ms. A subsequent paired transaction-strategy experiment under concurrent browser load produced:

| Pair | Per-record commits (ms) | Batches (ms) |
| --- | ---: | ---: |
| 1 | 16982.50 | 1379.12 |
| 2 | 1732.27 | 1449.98 |
| 3 | 25263.31 | 12933.93 |

These are local measurements, not portable latency guarantees. The large disk-load variance is why historical initialization must not share the new-event poll's 5-second deadline. Replay remains proportional to retained history; persistent incremental indexing is not introduced here.

## Validation

- Diagnostic unit suite: 100 passed, including malformed-record isolation.
- Host full coverage run: 600 passed, 2 skipped; coverage thresholds passed (statements 79.04%, branches 68.93%, functions 79.71%, lines 82.64%).
- Root lint, Host typecheck, and Host build passed.
- Three consecutive full hosted-profile Web runs after the batching fix: each 67 passed, 2 existing live-model tests skipped (4.8, 4.9, 4.5 minutes). The first run exercised batching before the setup/visibility split; the latter runs included that split. The final malformed-record guard was separately verified by the diagnostic and full Host tests.

Engineering scope: 2 product modules, 2 test files, and this report. No workflow, version, character prompt, Pi execution, or release artifact changes.

Release decision: do not publish from these local results alone. Automated publishing remains paused.
