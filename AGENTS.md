# Bear Harness engineering authority

These rules apply to the entire repository. They describe the product architecture approved for the current release and are hard constraints.

## Local development toolchain

- Run all Node.js and npm commands through `fnm exec --using=.nvmrc`, for example `fnm exec --using=.nvmrc npm install` and `fnm exec --using=.nvmrc npm run dev:web`.
- Do not rely on the shell's default `node`, `npm`, `npx`, or package-manager binaries. The version selected by `.nvmrc` must match the versions declared in `package.json`.

## Product boundary

- Bear is a managed local desktop product built around Pi Coding Agent.
- Pi remains authoritative for conversation content and agent execution: transcript entries, branches, messages, model changes, idle/streaming/error state, steering/follow-up queues, abort/edit/retry/navigation, tools, and native lifecycle events.
- Bear owns product and resource management: character packages, character runtime directories, session membership, archive/delete/rename orchestration, live `AgentSession` handles, explicit routing, Character/Display state, memory configuration and data placement, External Runs, Artifacts, security, and UI projection.
- A thin wrapper is still a manager. It may open, retain, route to, close, rename, archive, and delete Pi sessions. It must not reconstruct a competing copy of Pi-owned state.
- Do not add compatibility shims, dual reads/writes, aliases, fallback authority, or temporary state machines for models that this release removes.

## Local physical layout

Character packages and character runtime data are deliberately separate:

```text
<dataRoot>/
  system/
    settings.db
    security/
    providers/
    models/embeddings/
    updates/
  characters/<companionId>/
    character.yaml
    STORY.md
    assets/
    canon/
    plugins/
    skills/
  companions/<companionId>/
    runtime.db
    sessions/
    memory/MEMORY.md
    memory/tdai/
    runs/<runId>/
    artifacts/<sha256>
    audit/
    diagnostics/
```

- Every character's runtime files and character-scoped settings live below exactly one `companions/<companionId>/` directory.
- Character runtime data must not be stored in the installation database or another character's directory.
- The system database contains installation identity, application settings, provider accounts, the configured model pool, embedding configuration, update configuration, package registry/trust, and other genuinely installation-wide data only.
- The character database contains its Session Catalog, Character/Display state, character model defaults, character onboarding, Canon/Story runtime data, External Runs, Artifact metadata, and other character-owned records.
- SQLite foreign keys may not pretend to cross the system/character database boundary. A character database has its own immutable runtime identity.
- Artifact CAS is per character. Do not deduplicate or hard-link Artifact bytes across character directories.
- Character-specific diagnostics and audit material stays in the character directory. Global diagnostics may not contain character content.
- Directory and path components must be validated before use. Renderer requests never supply authoritative filesystem paths.

## Deletion

- Deleting a Session is Bear-managed: validate Catalog ownership, block new routes, abort if running, dispose the exact live handle and subscriptions, move/delete the exact transcript resource, then remove character-owned associated data. The operation is idempotent.
- Deleting a character runtime closes all Sessions, memory runtimes, Runs, and database handles before the character directory is moved to Trash or removed.
- Character package deletion and character runtime deletion are separate decisions.

## Conversation runtime

- One Host process may hold multiple real Pi `AgentSession` instances concurrently.
- The Registry may retain only actual handles, open de-duplication promises, event unsubscribe/dispose callbacks, and deletion exclusion needed to manage those resources.
- `active` means the conversation displayed by one Renderer window. It is UI-local and is not a Host or persisted global router.
- `open` means a live `AgentSession` handle exists in the Host process. It is ephemeral.
- `running` and `streaming` are Pi-native values derived from the corresponding `AgentSession`; Bear must not persist or mirror them.
- Switching the active UI conversation must never abort, dispose, or otherwise change another Session.
- Every conversation command and every External Run result is routed with an explicit `conversationId`.
- Concurrent open of the same Session is de-duplicated. Different Sessions may run different models simultaneously.
- Rename does not select a Session. Archive does not stop unrelated Sessions. Delete targets exactly one Session.
- External Run results are delivered to `run.conversationId`, including while that Session is running, using Pi native custom-message/follow-up behavior with `runId` idempotency.

Forbidden Host state includes copied messages, entries, leaves, tool execution state, queue contents, idle/streaming/error flags, inferred current turns, completion settlement, pending user turns, transcript journals, or a mutable global active conversation.

## Native streaming and UI projection

- The UI is a direct reactive projection of Pi snapshots and Pi native transient events.
- Preserve `message_update`, tool execution, queue, error, and settled events and tag each transported event with its Session id.
- Token/tool streaming stays on Pi's transient live-event channel.
- Reconnection uses an authoritative Session snapshot to replace the projection; events are not treated as a durable second transcript.
- UI timeline grouping, derived display labels, and other presentation calculations are allowed when they use one Pi source and remain reactive.
- UI may not introduce `sending` or other runtime flags that compete with Pi values.

## Session Catalog

- A character's Catalog owns Session membership and archive metadata. Pi owns title, messages, branches, model history, counts, and runtime state.
- Search joins Catalog membership with Pi-native title information without persisting a title copy.
- Catalog list rows are lightweight and paginated where necessary.
- Conversation open/get is non-destructive. Do not persist `conversation.selected` or implement Host `activeGet`.

## Character and Display

- `media`, `scenes`, and `visual` are top-level sibling character-package fields. The removed top-level `roleplay` wrapper, `choice_sets`, conditions, presentation modes, compatibility reads, and aliases must not return.
- Each media item declares asset metadata plus natural-language `description` and `use_when`. Host does not interpret `use_when` as a condition or permission.
- `host_media({ id })` resolves one declared media item. `host_choices({ prompt, choices })` creates choices only for the current response. Both remain ordinary Pi tool results at their native transcript positions and never write Character, Display, another table, or presentation history.
- Choice-button clicks send their natural-language message as ordinary user input. Choices have no ids, commands, callbacks, consumption state, lifecycle, or privileged semantics.
- Media and Artifact may share the same responsive preview column, but never ownership. Media belongs to its character package and Pi tool result; Artifact belongs to its External Run. Opening and closing a preview is UI-local and is not persisted or sent to Host.
- Character and Display share one storage/update mechanism and one reactive snapshot path while remaining separate semantic domains.
- Character State has only `global` and `conversation` scopes. Here `global` means the current installation/user and character pair.
- Every direct child of the Character root declares exactly one `x-scope`, restricted to the enum `global | conversation`; descendants inherit and cannot override it.
- Global and conversation top-level keys are disjoint and are composed shallowly.
- Display is conversation-scoped only.
- `host_state.read` reads the current documents. `host_state.update` accepts one or more `{ path, value }` changes and returns after validation and persistence.
- Standard JSON Schema `title` and `description` carry each field's model-facing meaning and update guidance. Simple numbers, booleans, and small independent enums are valid fields; interdependent narrative progress should normally be represented by natural-language summaries instead of coupled enum state machines.
- Runtime, queue, permission, Run, and Artifact state never enters Character/Display.
- UI may compute any reactive presentation projection from the authoritative Character/Display snapshot.

## Two-layer onboarding and settings

- System onboarding configures installation-wide capabilities: providers, credentials, configured model pool, default system models, network, embedding, download source, and local model acquisition.
- Character onboarding configures only a new character: first meeting, relationship choices, character memory consent, character default route selected from configured system models, and package-defined first-use choices.
- A new character never repeats provider, network, or embedding setup. Missing system prerequisites link to System Settings.
- Completed character onboarding is stored only in that character's runtime database.
- Embedding configuration and local embedding model cache are installation-wide Settings. API secrets stay in the credential vault.
- Embedding vectors, records, indexes, checkpoints, and explicit `MEMORY.md` remain physically isolated per character.
- Changing the embedding model or dimensions invalidates/rebuilds each character index independently and never mixes character data.

## Memory

- Explicit Memory and automatic TDAI memory are distinct domains.
- The role package, behavior (including `behavior.identity`, the single stable identity authority), Character field descriptions, Skill catalog, user address, and Explicit Memory form the Session's stable system context when the real Pi `AgentSession` is opened. Explicit Memory edits do not hot-rebuild an already running Session; the tool result remains in that Session and the file is reloaded on the next open.
- Current Character/Display and retrieved Canon/TDAI recall are temporary per-turn system context supplied through Pi's `before_agent_start`; they are not appended as transcript messages. Bear does not impose a character-count truncation or replace Pi's native context window and compaction behavior.
- `MEMORY.md` is edited only on an explicit user request to remember, change, or forget something; writes are bounded, locked, fsynced, and atomic.
- Automatic relationship memory follows the character's consent and uses the installation embedding configuration.
- Explicit Memory wins when it conflicts with inferred automatic memory.
- Deleting one Session does not delete character memory. Deleting the character runtime does.

## External Runs and Artifacts

- External Runs own executor lifecycle, permissions, evidence, temporary workspace, outputs, and result delivery. They never control Pi lifecycle or Character/Display commits.
- `active` and `running` are distinct. A result may be delivered to any target Session, including a running one.
- User interrupt and loss of an unrecoverable executor are distinct: user interrupt is resumable when the executor remains; confirmed controller loss becomes `forced_termination`.
- On startup, query or reattach an existing executor when the protocol supports it. Use `forced_termination` only when controller loss is confirmed and recovery is impossible; otherwise preserve the Run without inventing another product status.
- Generated outputs are Run-owned Artifacts. Capture validates path, symlinks, limits, MIME, size, and hash before committing to the character CAS.
- Artifact actions take immutable ids, validate `conversation -> run -> artifact` ownership and content integrity, and never accept arbitrary renderer paths.
- Artifact UI supports metadata, safe preview, open, reveal, Save As, provenance/evidence, and clear corruption/unavailability errors.
- Opening/revealing materializes a safely named presentation copy or uses an opaque capability; internal CAS paths are never exposed to Renderer code.
- Save As uses a native destination picker and does not persist the user's destination path.

## Result workspace and responsive layout

- Starting a Run does not force a split layout. Progress stays in the conversation timeline and the "current work" surface.
- Completing a Run signals that a result is ready but does not steal focus.
- Selecting a completed Run, Artifact, or timeline MediaCard opens the shared preview workspace. This layout reuse does not change domain ownership.
- At widths `>= 1600px`, conversation and result preview are adjacent columns. At `768..1599px`, the result is a right-side overlay/drawer. At `<= 767px`, it is a full-screen result view.
- Closing the result or switching to a conversation that does not own it returns to the normal conversation layout.

## Events and snapshots

- Product cache invalidations are transient process-local notices with no cursor or replay.
- Pi native events are transient runtime signals and are not written to SQLite as a parallel lifecycle.
- Bootstrap contains installation/global information. Conversation data is fetched for the selected Session. Do not build an O(N) full Character/Display snapshot for every conversation.
- Lists are lightweight; detail endpoints are explicit and bounded.

## Quality and release

- Rebuild or remove obsolete tests and documentation together with the model they described. Do not preserve dead compatibility behavior to satisfy stale fixtures.
- Add direct tests for Pi Registry concurrency, native streaming, event isolation, result routing/idempotency, rename/delete without selection, character path isolation, Artifact ownership/integrity/actions, and both onboarding layers.
- Required release gates: lint, typecheck, all unit tests, coverage thresholds, Web required E2E, Electron E2E, recovery suite, build, security audit/signatures, live-model validation, fresh platform packages, and packaged smoke on the same clean commit.
- WebDev acceptance includes real browser clicks through system onboarding/settings, new-character onboarding, two concurrent Sessions, streaming while switching, background Run completion, Artifact preview/open or Web download, result workspace responsive behavior, rename/archive/delete, and restart recovery.
- Release from a clean tree with a non-placeholder version and verifiable attestations. Public distribution additionally requires the platform signing/notarization policy.
- The final engineering report includes module/file/line counts, ownership boundaries, tests, known residual risks, and an explicit release decision.
