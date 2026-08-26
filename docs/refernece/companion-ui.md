# Companion UI module reference

## Scope and package surface

`@bear-harness/companion-ui` is a private, ESM SolidJS renderer package. Its package entry exports `CompanionApp`, the client-bound store/context (`createCompanionStore`, `DesktopProvider`, `useCompanionStore`), the IPC wire types/guards re-exported by the store, and renderer fault-reporting helpers. It also exports `styles.css` as a separate package path. The renderer receives a read-only `ProductConfig` and an injected `CompanionClient`; it does not create the client or read host files directly.

Primary source: [`packages/companion-ui/package.json`](../../packages/companion-ui/package.json), [`src/index.ts`](../../packages/companion-ui/src/index.ts).

The public component contract is:

```tsx
<CompanionApp product={productConfig} client={companionClient} />
```

`CompanionClient` is type-only at this boundary. It is the generated nested RPC facade around the environment's transport, not the Electron preload object itself. Store calls are envelope-unwrapped by `invoke` in [`src/stores/ipc.ts`](../../packages/companion-ui/src/stores/ipc.ts) and guarded before projection. A client is required; only the desktop-native attachment helper is optional, with browser upload fallback.

## Runtime composition and ownership

`CompanionApp` creates one TanStack Solid Query client with a 30-second stale time, no window-focus refetch, and no automatic query or mutation retry. It installs i18n and query providers, then binds one companion store to the injected client.

`DesktopProvider` supplies the store. `DesktopFrame` renders:

1. `Sidebar`;
2. the conversation stage (`SceneBackdrop`, `CharacterPresence`, native Pi `ConversationPanel`, `Composer`, and `FirstMeeting`);
3. `AttachmentPreviewProvider`, whose optional preview aside is part of the shell;
4. the controlled `Backstage` dialog.

There is no independent results context or run-output registry. User files, folders, and external-agent outputs all use the same conversation-attachment presentation path.

Ownership is split deliberately:

- **Store/query state:** snapshot cursor, conversation list, authoritative active Pi timeline/live state, runs and pending permissions, memory, settings/provider/model queries, onboarding, character runtime, and roleplay presentation IDs.
- **Conversation workflow state:** composer text, selected model workflow, upload drafts/progress/retry/cancel/error state, and sidebar edit/search state.
- **Preview state:** the selected attachment/path, semantic content/tree, short-lived capability URL, and local loading/download errors.
- **Host truth:** conversations and Pi sessions, attachment ownership and immutable bytes, model/provider configuration, external-agent runs, memory, character/canon records, and event ordering.

`createCompanionStore` is keyed by `CompanionClient` in a `WeakMap`. Locale-driven re-renders reuse the store and do not duplicate subscriptions or lose in-flight state.

## Snapshot, query, and event projection

The store starts with `snapshot.get`; its `eventSeq` seeds replay, onboarding hydrates immediately, and snapshot memory/run/character-runtime projections seed their query or reactive state. Conversation list and `conversation.activeGet` are authoritative supplementary queries. The active response is a native Pi projection containing `piSessionId`, `piTimeline`, and `piLiveState`.

The cleanup-bound event loop calls `events.subscribe(afterSeq)`. Duplicate events are skipped. A gap triggers `conversation.activeGet` plus snapshot recovery before replay continues.

Projection is intentionally narrow:

- `pi.session.changed` carries no message body; it refreshes only the matching conversation/session projection and cannot overwrite a newly selected conversation.
- conversation/model/onboarding/memory/run/character/roleplay/settings events refresh their authoritative query or bounded local projection;
- `run.needs_user` retains the permission request by run ID; terminal/resume events clear resolved permission state and refresh runs;
- evidence, Codex, filesystem, and diagnostics events do not map to renderer fields and are ignored.

Presence derives from companion state, active runs, and native Pi streaming: unavailable/crashed or failed runs become `problem`; `needs_user` is explicit; other active runs become `thinking`; streaming/sending becomes `listening`; otherwise the UI is idle.

## Onboarding and first meeting

[`src/stores/onboarding.ts`](../../packages/companion-ui/src/stores/onboarding.ts) is a separate reactive wrapper around `client.onboarding.get` and `.submit`. It starts from a safe active placeholder, hydrates once from the boot snapshot, ignores lower event sequences, parses `onboarding.state_changed` through the protocol schema, and refetches on `onboarding.reset`. Every Host submission returns the authoritative next state; the renderer does not calculate step transitions.

`FirstMeeting` reads the active character package's `character.first_meeting` definition and matches `store.onboarding.currentStepId` to a role-defined step. It renders package-provided headings, body, quote, note, labels, choices, and text constraints. Acknowledge, text, and choice steps all call `store.submitOnboarding(step.id, answer?)`; local guards prevent double submits of one step and the store handles stale-step conflicts by resyncing from the Host.

Before package onboarding can appear, `FirstMeeting` gates two setup dialogs:

1. **Reply-model setup:** provider list, provider credential (API key or OAuth/device flow), optional relay/base URL, optional Pi config import, model enable, and default reply route. Calls route through `provider.list`, `provider.setApiKey`, `provider.login`/`loginStatus`/`loginAnswer`, `provider.overrideBaseUrl`, `provider.importPiConfig`, `model.enable`, and `model.setDefaultReply`.
2. **Vector-memory setup:** local/none embedding selection persisted through `settings.set({ memoryVectorService: ... })`.

The role-defined dialog is only shown once required setup is complete, the store is not loading, and the Host reports an active current step. Errors are rendered as alerts; setup controls use local busy state.

## Conversation, composer, attachments, and model routing

### Native Pi conversation projection

`ConversationPanel` renders `activePiTimeline.entries` directly. User and assistant message entries render their native text and attachment summaries; tool entries render tool name, call ID, and success/failure; context entries render a separator. `PiLiveState.streamingMessage` is the only transient assistant projection and is replaced naturally when `pi.session.changed` refreshes the durable timeline. The UI does not rebuild message versions or merge local transcript copies.

Each timeline attachment row shows its name, kind, file count, and byte count. Activating it opens the shared attachment preview panel. A `WorkTimelineItem` below its trigger entry shows any direct external-agent runs associated with that Pi entry.

### Composer and upload lifecycle

Composer owns unsent text and attachment drafts. Enter submits; Shift+Enter inserts a newline. A send is allowed when a conversation/model exists, every attachment upload is complete, and either trimmed text or at least one attachment is present.

The attachment menu supports files and folders. In desktop builds it prefers the trusted preload bridge:

- `pickFiles(conversationId)` opens an owned native multi-file picker;
- `pickFolder(conversationId)` opens an owned directory picker;
- dropped `File` objects are handed to `importDroppedFiles`, where preload converts them to native paths with Electron `webUtils`.

WebDev/fallback flows enumerate browser files or directory handles and use `conversationAttachment.startUpload`, 1 MiB-bounded `appendChunk` calls, and `completeUpload`. Upload drafts expose progress, cancel, retry, and remove. Removing a completed unsent draft calls `conversationAttachment.discard`.

`dispatchMessage` sends only `attachmentIds` through `message.send`; it never inlines file bytes or local paths. Accepted drafts clear only after Host/Pi preflight succeeds. Failed sends restore the exact text and attachment draft.

### Model/provider settings

Model data is split into pool, defaults, and a conversation route. Composer selection updates the active route and default reply model. `SettingsSheet` manages provider credentials/login, custom providers/base URLs, enabled models, reply/vision defaults, proxy/vector-memory/download-source settings, and Host capabilities. Credentials remain password inputs and are not projected back as plaintext.

## Direct-run timeline and attachment preview

### Run controls

For each Pi message entry, `WorkTimelineItem` filters runs by exact `triggerEntryId`. There is no renderer proposal, approval, rejection, or launch step. The conversational role starts an independent agent through its Host delegation tool; the renderer receives run events and `run.list` projections.

`WorkRunCard` shows title and status and provides only controls valid for an existing run: steer while `running`/`needs_user`, interrupt active work, resume an interrupted run, cancel from a permission card, and answer executor permission options. Busy/error state is local to the card. Character packages may override completed/failed labels.

Completed external-agent files re-enter the conversation as ordinary generated attachment summaries on a native Pi timeline entry.

### Attachment preview panel

`AttachmentPreviewProvider` owns one optional shell aside. A selection is `{ conversationId, attachment, relativePath?, entry? }`; switching or closing invalidates stale loads and clears the prior URL/state.

- A folder root performs a semantic read and renders the bounded entry list. Selecting a file carries its exact relative path.
- Text-like files use semantic reads and render extracted content in a `<pre>` text node.
- Image, audio, video, and PDF previews request `conversationAttachment.url({ operation: "preview" })`.
- Unknown types show name, MIME, and byte metadata rather than executing content.
- Download requests a separate `operation: "download"` URL and clicks a temporary anchor.

The store exposes semantic `attachments.read` and byte `attachments.readBytes` as separate helpers over the strict `conversationAttachment.read` union. Each asserts the response discriminator. The current preview panel uses semantic reads or desktop preview/download capabilities; it does not construct URLs from paths or read the internal CAS.

## Backstage, settings, memory, and role management

`Backstage` is a controlled Kobalte `Dialog` styled as a right-side sheet. Standalone system settings render `SettingsSheet`; character settings expose only role management and memory tabs.

Role management imports package directories, lists/activates roles, reviews plugin trust, and mounts `CurrentRolePackageManager` for the active package document, character-scoped settings, and memory-candidate actions. Memory supports scoped search/list/edit/forget/exclude plus pending candidate approval/rejection. These surfaces call Host-backed store APIs and keep action feedback local.

## Character scene, presence, and roleplay media

Runtime chooses the active scene from the active conversation’s character runtime scene ID, falling back to the character visual default scene. `SceneBackdrop` renders only a Host-provided `backgroundUrl`; package assets are converted by the Host to data URLs before reaching the sandboxed renderer.

`CharacterPresence` chooses an explicit runtime visual state when present, otherwise maps store presence to `presence`, `listening`, `thinking`, `needs_user`, `result_ready`, or `problem`. It falls back to the character’s default expression and exposes the package expression label through a `role="img"` wrapper while the image itself has empty alt text.

Roleplay state is snapshot-backed; media and choice presentation IDs are event-projected. Choice sets render inline and call `triggerRoleplayEvent`, which sends a conversation-scoped event with a random dedupe key, clears the selected choice set, and refetches the snapshot. Media has three presentation modes:

- `inline`: rendered in the conversation with a close button;
- non-inline/non-ambient: rendered in a Kobalte dialog overlay with title, close button, and focus behavior;
- `ambient` audio: rendered as a fixed player with stop control.

Audio/video use autoplay plus controls, loop metadata, URLs and optional captions. Animation images switch to `posterUrl` under `prefers-reduced-motion: reduce`. Backstage roleplay archives show only non-hidden variables and unlocked collections, with lazy image media and metadata-preloaded audio/video.

## Accessibility, i18n, and visual conventions

Kobalte primitives provide keyboard and ARIA behavior for buttons, dialogs, tabs, selectors, text fields, file fields, checkboxes, and collapsibles. The shell uses `role="application"`; the thread is live; upload, run, setup, and preview failures use local alerts; native Pi tool/run/attachment rows expose stable data attributes for focus and testing.

The attachment preview is a labelled `aside`; its folder entries are buttons, media receives a localized accessible label, PDF uses a labelled object fallback, and closing removes the panel selection. Arbitrary user audio/video has no fabricated caption content.

All user-facing strings use `@bear-harness/i18n` or validated character-package copy. Character themes override semantic CSS variables. `SUPPORTED_DESKTOP_MIN_WIDTH` is 800 CSS pixels; narrower supported desktop layouts compact the shell while the attachment preview remains a shell column.

## Error and security boundaries

- `invoke` unwraps validated envelopes while preserving domain versus transport failures; cross-client payload guards reject malformed projections.
- Snapshot/event gaps recover from authoritative Host state. Initiating components own operation alerts; only unrecoverable projection/stream failures populate the thread error.
- Renderer code sends attachment IDs, relative paths within an attachment, upload chunks, or strict read parameters—never arbitrary native source paths through ordinary RPC.
- Native picker/drop paths cross only the trusted Electron preload/main bridge and are snapshotted before summaries return to the renderer.
- Text is rendered as DOM text. Media/PDF and downloads use Host-minted operation-scoped capabilities—`bear-attachment` on desktop and a relative bearer route in WebDev—not `file:` URLs or internal CAS identifiers.
- Semantic and byte reads remain distinct all the way through the store; callers cannot accidentally reinterpret extracted text as exact bytes.

## Current findings

1. **The active thread is native Pi state.** `conversation.activeGet` and `pi.session.changed` own durable timeline refresh; the renderer does not maintain a parallel message-version model.
2. **All visible files are attachments.** User file/folder snapshots and generated run outputs share the timeline row and preview panel.
3. **Desktop path access is privileged.** The optional preload bridge improves native picker/drop behavior; browser builds fall back to chunked uploads without exposing filesystem paths.
4. **Preview capabilities are operation-specific.** Preview and download request separate URLs; unsupported preview MIME types fail rather than being rendered under a permissive fallback.
5. **Run UI controls existing work only.** Delegation happens through the role's Host tool, so the renderer has no launch or approval state to race with the run FSM.

## Verification commands

The package declares these commands in [`package.json`](../../packages/companion-ui/package.json):

```sh
npm --prefix packages/companion-ui run build
npm --prefix packages/companion-ui run typecheck
npm --prefix packages/companion-ui run test:unit
npm --prefix packages/companion-ui run test:coverage
```

`build` and `typecheck` both run TypeScript with `--noEmit`. The unit/coverage scripts first build the local `product-config`, `i18n`, `protocol`, and `companion-client` packages, then run Vitest. [`vitest.config.ts`](../../packages/companion-ui/vitest.config.ts) uses jsdom, `vite-plugin-solid`, `tests/setup.ts`, and `tests/**/*.spec.{ts,tsx}`; coverage is V8 under `coverage/ui` with 80% statement/function/line and 70% branch thresholds (excluding declaration files and `NetworkAndMemorySettings.tsx`).

Focused tests under [`packages/companion-ui/tests`](../../packages/companion-ui/tests) cover the native Pi timeline/live projection, attachment composer uploads and ID-only send, attachment preview, store/client/event guards, run controls, onboarding, memory, model/provider settings, role management, roleplay, locale stability, accessibility, and renderer diagnostics.
