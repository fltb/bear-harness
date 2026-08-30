# Bear Harness engineering authority

These rules apply to the entire repository. They are hard project constraints, not suggestions.

## User authority and scope

- Implement only the behavior and file surface explicitly approved by the user for the current round.
- Do not broaden a task because of reliability, completeness, best practices, future needs, compatibility, or convenience.
- If a change would add a table, persisted field, state enum, state machine, queue, recovery mechanism, compatibility path, fallback, cache, service, abstraction, or authority boundary, stop and obtain explicit user approval first.
- Report out-of-scope findings without changing them.
- Do not use refactors, migrations, compatibility shims, dual reads/writes, aliases, or temporary bridges to preserve a model the user ordered removed.
- Options and choice buttons are ordinary user input. They must not have a separate command protocol, state machine, or privileged semantics.

## Absolute Pi passthrough boundary

Pi Coding Agent is the sole authority for every conversation concern. Host and UI are forbidden from managing conversations in any form; they may only call Pi public APIs and expose Pi-native values and events without reinterpretation.

Pi owns:

- sessions, agent runtime state, turns, messages, titles, branches, and transcript persistence;
- idle/streaming/error state and streaming content;
- steering and follow-up queues;
- abort, edit, retry, navigation, and continuation behavior;
- agent, turn, message, tool, queue, and lifecycle events.

Host and UI may call Pi and render a direct reactive projection of Pi. They must not reconstruct, persist, mirror, reclassify, infer, buffer, settle, gate, block, recover, or coordinate a competing version of Pi-owned state.

Specifically prohibited:

- `CompanionSupervisor` runtime state that mirrors Pi session or agent state;
- UI `sending` state that mirrors `isStreaming` or `pendingMessageCount`;
- Host lifecycle events used as a second authority over Pi events;
- reconstructed tool execution state when Pi already emits tool events;
- timeline scans that infer whether a Pi turn settled;
- direct assignment to `agent.state.messages`;
- manual branch/leaf/message synchronization when a complete Pi API exists;
- mutable global conversation routing such as `activeConversationId`;
- per-turn skill-read gates or other hidden Host turn state;
- companion permissions sourced from external Runs;
- Host-owned pending user-turn persistence, replay, markers, or recovery.
- Host-owned conversation, turn, message, response, tool-loop, or lifecycle managers of any name;
- per-conversation or per-turn Host state keyed by Pi session IDs, message IDs, entry IDs, tool-call IDs, or inferred current turns;
- Host turn journals, effect buffers, failed-turn flags, completion settlement, abort cleanup, or transaction lifetimes spanning multiple Pi tool calls;
- using a Host tool result to block, cancel, roll back, reinterpret, or otherwise control later Pi calls;
- subscribing to Pi events in order to decide when Host conversation work commits or rolls back;
- temporary conversation projections or compatibility layers, even when described as recovery, atomicity, synchronization, UX, or safety.

`pending_turns`, `PendingTurnStore`, `host_pending_turn`, and their states, reconciliation, retry, crash recovery, sync triggers, tests, and compatibility paths must be deleted completely. The older proposal to retain `pending_turns` for crash recovery is superseded by this rule.

Permitted Host-owned state is limited to:

- Character State: product and narrative semantics the model can understand;
- Display: the current conversation's Host/UI presentation mapping;
- generated artifacts owned by an external Run;
- external Run state that belongs to the external Run aggregate and is never inserted into companion state;
- the total-session catalog's minimal `Pi session id -> companion id, archived at` binding.

Every Character or Display mutation must be validated and committed atomically inside that single Host tool invocation. It may use the `conversationId` supplied by Pi only as the product-data scope key. It must not retain Pi session, turn, entry, message, or tool lifecycle identifiers after the invocation, and must not wait for any later Pi event. One Host tool result has no authority over any other Pi call.

## Character and Display model

- `roleplay` is a first-class character-package semantic domain. It contains narrative variables, conditions, media, unlockables, and natural-language choice sets; it must not be renamed to or flattened into generic `resources`.
- `resources` remains the existing static/runtime asset concept (for example skill resources). It must not replace `roleplay`, and restoring `roleplay` must not rename legitimate resource APIs.

- `CompanionStateStore` and `CharacterDocumentEngine` are part of this round's mandatory core cleanup. They may not remain as two overlapping stores or as a facade that forwards one store while independently implementing another.
- Character and Display must use one storage/projection mechanism with one reactive snapshot path. UI is a projection of that path, not another authority.
- `CompanionStateSnapshot` may contain only Character State, conversation-scoped Display, and the schema/revision metadata strictly required to update those two domains.
- Delete `runtimeState` and `permissions` from `CompanionStateSnapshot`, Host snapshot assembly, protocol schemas, UI reads, query invalidation, fixtures, and tests. Moving these fields from the old `presentation` object into companion state was an error, not a valid consolidation.
- Runtime/streaming/error/queue information is projected directly from Pi. External permission requests are projected only from their owning Run. Neither may be copied into companion state.
- Delete UI `sending` and any presence derivation that treats it as an authority. UI loading and streaming indicators must be pure projections of Pi-native state.
- The UI `packages/companion-ui/src/stores/companion.tsx` is part of this round's mandatory Companion Store cleanup. It must not retain duplicate conversation runtime fields or absorb unrelated Run permissions.
- State has only `conversation` and `global` scopes.
- `global` means the current installation/user and companion pair. It is not cross-user, cross-character, or cloud-global.
- Character scope is a top-level static partition. Every direct child of the Character State root declares exactly one `x-scope`; descendants inherit it and may not declare or override scope.
- Global and conversation top-level keys are disjoint. Reconstruct Character State by shallowly composing defaults, global partitions, and conversation partitions. Recursive scope splitting, recursive scope merging, and scope override priority are forbidden.
- The model sees one semantic Character document and one Display document. Scope names, per-scope revisions, schema hashes, storage ids, and merge order are Host/UI metadata and must not be injected into model context.
- Delete the old `relationship` and `character` storage scopes. Do not retain aliases, migration reads, fallback merge order, or compatibility branches for them.
- Character fields declare whether they are conversation or global fields.
- Display is conversation-scoped only.
- Keep Character and Display as separate domains in the same reactive data model and storage system.
- Delete the independent `collection` domain.
- Delete collection mutations, revisions, schemas, persistence, sync sources, tool exposure, model context, and writable APIs; do not merely hide collection from the UI.
- Narrative progress and user-known story facts belong in Character State, Canon, or memory as appropriate.
- Resource unlocks are derived from Character State and resource conditions.
- Displayed-media deduplication is internal presentation history; it is not injected into the model as Character State.
- Any gallery or collection UI is a read-only projection of Character State and presentation history.
- Delete durable `pending_state_mutations`, in-memory turn journals, Pi-bound effect accumulation, turn-settlement inference, completion commits, and abort/error rollback handlers. Host product-data writes end with the individual Host tool call.

## Explicit Host side domains

There is no generic sidecar store, sidecar payload, collection, or `{domain,type,status,payload}` bucket. The only data adjacent to a Pi session is managed by these named authorities:

1. **Companion State** owns Character and Display only. Character uses the top-level global/conversation partitions above; Display is conversation-only. `host_state` is the only model write entry and commits Character and Display atomically inside one tool call.
2. **Local files and Artifacts** are deliberately asymmetric. Local input files remain at their original absolute paths; the picker inserts those paths into ordinary user text and creates no upload, copy, attachment id, entry binding, persistence, or lifecycle. Pi's native read-only tools read ordinary files, while the stateless `document_read` Host tool parses PDF, DOCX, XLSX, and PPTX. Generated outputs belong only to their external Run as Artifacts.
3. **External Runs** own their executor lifecycle, permissions, evidence, and result artifacts. A Run records its originating conversation and trigger entry as immutable references. It cannot alter Pi lifecycle state or Companion State. Completed results return through a Pi custom message.
4. **Session Catalog** owns only companion membership and archive metadata for the total list of Pi sessions. Archive/restore changes that metadata; delete calls Pi and removes associated Host data; search is a read-only projection over Pi titles. It may not persist or reconstruct title, messages, counts, leaf, streaming, error, queue, runtime, or model state.

Cross-domain rules:

- Domains link by immutable ids and never copy another domain's state.
- UI joins authoritative reads; events are invalidation notices only, not replicated business data or lifecycle transitions.
- No mutable global active-conversation router may select a target for tools, attachments, or Runs.
- Deleting a conversation removes its conversation Character partition, Display, attachment data according to attachment retention rules, Run data according to Run retention rules, and catalog binding. Global Character remains.

## Current core-reduction release gate

This round does not pass unless the conversation-flow core is reduced by at least 50 percent. This is a mandatory net-reduction gate.

The locked baseline is the current physical line count of these production files:

| File | Baseline lines |
| --- | ---: |
| `packages/host-runtime/src/companion/supervisor.ts` | 1,624 |
| `packages/host-runtime/src/companion/turn-pipeline.ts` | 953 |
| `packages/host-runtime/src/companion/pi-session-store.ts` | 411 |
| `packages/host-runtime/src/companion/character-behavior.ts` | 859 |
| `packages/host-runtime/src/companion/pending-turn-store.ts` | 510 |
| `packages/host-runtime/src/companion/companion-store.ts` | 758 |
| `packages/host-runtime/src/companion/state-service.ts` | 793 |
| `packages/companion-ui/src/stores/companion.tsx` | 2,906 |
| **Total** | **8,814** |

At final review, the surviving conversation-flow and companion-state implementation across these files must total at most **4,407 physical lines**. A deleted file counts as zero.

This numeric gate may not be bypassed by:

- moving or copying conversation-flow logic to another file, package, generated source, helper, adapter, compatibility layer, or test;
- renaming files or symbols;
- replacing code with data-driven state machines, schemas, generated code, metaprogramming, or opaque wrappers;
- excluding newly created conversation-flow files from the count;
- deleting comments, whitespace, types, validation, or tests while retaining equivalent duplicate runtime logic;
- weakening tests or changing the measurement baseline.

Any new or relocated conversation-flow or companion-state implementation outside the eight baseline files must be added to the final line total. The architectural prohibitions above must also pass; meeting the number alone is insufficient.

The final report must include:

1. baseline and final physical line counts for every counted file;
2. any additional conversation-flow files added to the total;
3. deleted duplicate authorities and their Pi-native replacements;
4. proof that no prohibited pending-turn, lifecycle, queue, tool, permission, skill-read, UI-sending, collection, legacy scope, duplicate companion store, or inferred turn-settlement authority remains;
5. focused tests plus the full relevant test suite.

Until both the architectural checks and the 50 percent net-reduction gate pass, the work must be reported as incomplete.

## Rebuilt Host-core aggregate size gate

- The entire Host core deleted and rebuilt in this cleanup must total at most **1,500 physical lines**. This is the normal pass line, not an aspirational target.
- The aggregate includes all production code implementing Pi passthrough, conversation entry/routing, Character/Display tools, and Character/Display storage. It includes rebuilt code under the former `supervisor.ts`, `turn-pipeline.ts`, `pi-session-store.ts`, `conversations/repository.ts`, `character-behavior.ts`, and `companion-store.ts` responsibilities.
- Any replacement or relocated implementation in `runtime.ts`, `composition.ts`, another existing file, a new helper, adapter, schema-driven engine, or generated source is added to the same aggregate total.
- Splitting the implementation across files does not reset the count. Dense formatting, metaprogramming, embedded state-machine data, compatibility facades, generated code, aliases, or forwarding wrappers may not be used to evade the aggregate.
- Any total above **1,500 lines** fails this cleanup. A combined total of **2,000 lines or more** is also conclusive evidence that Host authority has expanded beyond the approved boundary; it cannot pass even when tests pass.
