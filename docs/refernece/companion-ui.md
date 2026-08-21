# Companion UI module reference

## Scope and package surface

`@bear-harness/companion-ui` is a private, ESM SolidJS renderer package. Its package entry exports `CompanionApp`, the client-bound store/context (`createCompanionStore`, `DesktopProvider`, `useCompanionStore`), the IPC wire types/guards re-exported by the store, and renderer fault-reporting helpers. It also exports `styles.css` as a separate package path. The renderer receives a read-only `ProductConfig` and an injected `CompanionClient`; it does not create the client or read host files directly.

Primary source: [`packages/companion-ui/package.json`](../../packages/companion-ui/package.json), [`src/index.ts`](../../packages/companion-ui/src/index.ts).

The public component contract is:

```tsx
<CompanionApp product={productConfig} client={companionClient} />
```

`CompanionClient` is type-only at this boundary. The client is the preload facade with one promise-returning method per IPC channel. Calls are envelope-unwrapped by `invoke` in [`src/stores/ipc.ts`](../../packages/companion-ui/src/stores/ipc.ts). The store keeps defensive runtime guards and treats an absent/missing bridge as unavailable data rather than allowing malformed data into the presentation projection.

## Runtime composition and ownership

`CompanionApp` creates one TanStack Solid Query client with these defaults:

- query stale time: 30 seconds;
- no refetch on window focus;
- queries and mutations do not retry automatically.

It installs `I18nextProvider`, then `QueryClientProvider`, and renders the private `CompanionRuntime`. Runtime creates/reuses the store, owns only the Backstage open/tab signals and the dismissible language-warning key, and derives character, active scene, composer placeholder, language mismatch, and CSS theme properties. It sets `document.title` from `product.productName`.

`DesktopProvider` supplies the store to the component tree. `ResultSpaceProvider` supplies the per-conversation result-column context. `DesktopFrame` composes the shell in this order:

1. `Sidebar` (identity, conversation search/list, conversation actions, Backstage entry points).
2. Main stage: optional language warning, `SceneBackdrop`, `CharacterPresence`, `ConversationPanel`, story proposal confirmation, `Composer`, and `FirstMeeting`.
3. `ResultSpace` (conditionally visible right column).
4. `Backstage` (a controlled dialog/drawer).

The app root has `role="application"`, labels itself with the product name, and exposes the result-column state as `data-result-open`. CSS changes the shell from two columns to three when that attribute is true. `ConversationPanel` and `Composer` do not own conversation identity; they read it from the store.

Solid ownership is intentionally split:

- **Store-owned reactive state:** boot/supplementary snapshots, active conversation and messages, optimistic pending text, streaming text/status, tool activity, run/presence, onboarding projection, character runtime, roleplay presentation IDs, errors, and domain lists.
- **Query-owned cache:** settings, provider list, model pool/defaults, and per-conversation model routes. The store exposes these through flat `settings`, `provider`, and `model` APIs.
- **Component-local state:** text fields, edit/correction dialogs, loading/busy flags, selected tabs, temporary errors/feedback, attachment drafts, and focus-return references.
- **Host-owned truth:** conversation history, model/provider configuration, onboarding transition rules, memory, commission/run/artifact/story/character/canon records, and event sequencing.

`createCompanionStore` is keyed by `CompanionClient` in a `WeakMap`. A re-run of `CompanionRuntime` caused by locale changes therefore reuses the same store and does not lose event subscriptions, cache, or in-flight state. A different client gets an isolated store.

## Snapshot, query, and event projection

The store starts a Solid `createResource` for `client.snapshot.get()`. The snapshot's `eventSeq` seeds the event cursor and hydrates:

- onboarding state;
- active conversation ID/branch/messages and conversation summaries;
- memory entries, runs, commissions, artifacts, story changes;
- character runtime-by-conversation.

After the snapshot succeeds, a cleanup-bound asynchronous loop calls `events.subscribe(afterSeq)`. It polls again after an empty batch or subscription failure. A sequence gap marks the projection stale and refetches the snapshot. Duplicate/replayed batches are skipped; accepted events advance the cursor. Snapshot failure is shown through the store error and retried after five seconds. Supplementary lists are fetched on first boot and via per-domain refresh helpers.

`dispatchEvent` performs a narrow projection rather than forwarding every event to the UI:

- `message.user_sent`, `message_start`, `message_update`, `message_end`, `message.assistant_committed`, and `message.aborted` drive sending/streaming flags and snapshot reconciliation.
- Tool-start/finish events update conversation-scoped tool activities.
- Character scene/visual events update `characterRuntimeByConversation`; roleplay media/choice events update active presentation IDs.
- Conversation/model/onboarding/run/memory/provider/commission/artifact/story/character/settings events refetch or invalidate their corresponding domain.
- Evidence, codex, filesystem, and diagnostics events are intentionally ignored because they do not invalidate a projected UI field.

Stream IDs and persisted Pi-entry IDs differ. The store therefore reconciles streamed assistant text by content: a persisted final whose text starts with the stream (or exactly equals it) clears the draft and prevents a late delta from resurrecting “responding”. `ConversationPanel` independently hides a streamed draft when the last visible assistant version has the same trimmed content, preventing duplicate rendering.

`derivePresence` is store-owned. `crashed`/`unavailable` companion state becomes `problem`; any active `needs_user` run becomes `needs_user`; other active runs become `thinking`; sending with no active run becomes `listening`; completed/adopted latest runs become `result_ready`; failed/forced runs become `problem`; otherwise the state is `idle`. `CharacterPresence` maps that state to a package expression ID, falling back to the package default expression when the requested expression is absent.

`createRpcQuery`/`createRpcMutation` in [`src/stores/rpc-query.ts`](../../packages/companion-ui/src/stores/rpc-query.ts) centralize query keys and invalidation. Mutation success invalidates its configured keys; `refreshRpcQuery` invalidates without refetching and then fetches. All cross-client payloads are passed through `invoke` and the guards in `stores/ipc.ts` before projection.

## Onboarding and first meeting

[`src/stores/onboarding.ts`](../../packages/companion-ui/src/stores/onboarding.ts) is a separate reactive wrapper around `client.onboarding.get` and `.submit`. It starts from a safe active placeholder, hydrates once from the boot snapshot, ignores lower event sequences, parses `onboarding.state_changed` through the protocol schema, and refetches on `onboarding.reset`. Every Host submission returns the authoritative next state; the renderer does not calculate step transitions.

`FirstMeeting` reads the active character package's `character.first_meeting` definition and matches `store.onboarding.currentStepId` to a role-defined step. It renders package-provided headings, body, quote, note, labels, choices, and text constraints. Acknowledge, text, and choice steps all call `store.submitOnboarding(step.id, answer?)`; local guards prevent double submits of one step and the store handles stale-step conflicts by resyncing from the Host.

Before package onboarding can appear, `FirstMeeting` gates two setup dialogs:

1. **Reply-model setup:** provider list, provider credential (API key or OAuth/device flow), optional relay/base URL, optional Pi config import, model enable, and default reply route. Calls route through `provider.list`, `provider.setApiKey`, `provider.login`/`loginStatus`/`loginAnswer`, `provider.overrideBaseUrl`, `provider.importPiConfig`, `model.enable`, and `model.setDefaultReply`.
2. **Vector-memory setup:** local/none embedding selection persisted through `settings.set({ memoryVectorService: ... })`.

The role-defined dialog is only shown once required setup is complete, the store is not loading, and the Host reports an active current step. Errors are rendered as alerts; setup controls use local busy state.

## Conversation, composer, and model/image routing

### Conversation projection and message operations

`ConversationPanel` filters wire messages to user and assistant roles, retaining system/tool-result entries in the store but never exposing them in the user-facing thread. It scrolls to the bottom when visible message count changes. It renders a greeting when there is no visible history, and separately renders optimistic pending user text, tool traces, and an assistant streaming draft/status.

Each `MessageItem` adopts the message's explicit `adoptedVersionId`, otherwise an adopted version, otherwise the last version. User messages expose edit; assistant messages expose a deferred action toolbar that remains keyboard reachable. Operations map directly to store methods:

| UI operation | Store/client path |
| --- | --- |
| Edit and save | `editMessage(id, text, isUser)` → `message.edit` |
| Previous/next version | `switchVersion(messageId, versionId)` → `message.switchVersion` |
| Regenerate | `regenerateMessage(id)` → `message.regenerate` |
| Continue (last assistant only) | `continueConversation()` → `message.continue` |
| Branch | `branchMessage(id)` → `message.branch` |
| Correct with reason/scope | `correctMessage(reason, once\|session\|always)` → `message.correct` |
| Remember assistant moment | `memory.capture(messageId)` → `memory.capture` |
| Stop an in-flight turn | `abort()` → `message.abort` |

Editing trims and rejects an empty value locally. Correction requires a preset or non-empty custom reason. Capture reports success/error locally. Store conversation/message actions require an active conversation and place failures in the shared `store.error`; the panel displays that error as an alert.

The panel listens for `bear-result:locate`. ResultSpace emits that event with conversation/message IDs; the panel ignores events for another conversation, scrolls the source message into view, gives it a temporary `tabindex=-1`, and focuses it without changing the result selection.

### Composer

`Composer` owns the unsent text and attachment draft. Enter submits; Shift+Enter remains a newline. The selected reply model is loaded per active conversation through `store.model.list(conversationId)` and selected with `store.model.select`. The input and file picker remain disabled until a conversation and configured model are selected.

Files are constrained by shared protocol constants (`MAX_MESSAGE_ATTACHMENTS`, `MAX_MESSAGE_ATTACHMENT_BYTES`) and accepted as image or text/material extensions. Text files are read locally and inlined into the message with a localized material label. Images are base64 encoded and passed as native attachment objects to `store.sendMessage`; the renderer does not create a separate image message.

Image routing is explicit and keeps the selected reply model unchanged:

- If attachments contain images and the selected model does not support images, the composer looks for `store.model.data().multimodalFallback`.
- With no fallback, send is disabled and a settings shortcut requests focus on the vision selector (`requestImageReaderFocus`) before opening Backstage settings.
- With a fallback, the composer announces which model reads the images.
- If the Host rejects image routing, the exact text and attachments are restored, an alert offers retry/settings/remove-images, and the draft remains blocked until one of those paths is chosen.

The store sets `pendingUserText` before `message.send`; Composer uses that retained value to distinguish a rejected image route from a successful dispatch. The send slot changes to Stop while sending, streaming text is present, or a pending message remains.

### Model/provider settings

Settings and model route state are split as follows:

- global settings use query key `settings` and `settings.get/set`;
- providers use `providers` and `provider.*` calls;
- enabled model pool uses `models/pool`;
- global reply/vision defaults use `models/defaults`;
- selected route is keyed by `models/route/<conversationId>`.

`SettingsSheet` loads provider and model data on mount, supports product locale selection, API-key credentials, OAuth polling/prompts, custom base URL, Pi-config import, model pool enable/disable, default reply selection, and vision mode (`auto` or an explicitly configured image-capable route). Store mutations invalidate/refetch the relevant query. The composer’s one-shot focus request lands on the vision selector after settings opens.

`NetworkAndMemorySettings` is mounted inside settings and persists proxy, vector-memory, and download-mirror settings through `settings.set`; its source notes that vector service/mirror changes require restart while proxy changes apply live. Relationship-memory and conversation-history-read switches in Backstage also use `settings.get/set`.

## Message-scoped work timeline and ResultSpace

### Timeline projection

For each visible user message, `ConversationPanel` renders `WorkTimelineItem(messageId, character)`. The component filters commissions by exact `triggerMessageId` and by active conversation (unless the commission has no conversation ID). Unrelated messages render no work line.

A draft/approved commission renders `WorkProposalCard`: approve (for drafts, with the draft hash) then launch with the fixed executor profile `pi-product-managed`, or reject. A run card filters artifacts by `producerRunId`, pending permissions by run ID, and exposes:

- steering while running or waiting for user;
- interrupt for enqueued/running/needs-user and resume for interrupted;
- permission options or run cancellation;
- completed artifact count, per-artifact download, and “view artifacts”;
- failure status and collapsible artifact/tool detail.

All controls call `store.commission.*`, `store.run.*`, or `store.artifact.download`. Busy state is local to each card. Character packages may override timeline labels through `character.work_presentation.labels`.

### Dual-column ResultSpace

`ResultSpaceProvider` stores an entry per conversation and a last-viewed artifact ID per run. A result selection requires conversation, trigger message, commission, run, and artifact IDs. Opening a result uses the run’s last-viewed artifact when available; closing restores focus to the opener. Escape closes the active conversation’s result view. Selecting an artifact updates the active selection and remembers the tab for the run.

The `ResultSpace` column derives its artifact list from the selected run, its title from the selected commission, and its source summary from the trigger message. It uses Kobalte `Tabs` for one artifact per tab. The `ArtifactPreview` MIME router supports text, Markdown, image, audio, video, and a metadata/download page for other types:

- text/Markdown bytes are read through `artifact.read`, UTF-8 decoded, and rendered in `<pre>` text nodes (not injected as HTML);
- media first requests a Host-issued safe URL via `artifact.url`; if empty, it reads host bytes and creates a temporary Blob URL;
- object URLs are revoked on cleanup;
- renderer URLs are never built from arbitrary filesystem paths;
- media has controls and generated caption tracks; unknown file types expose name, MIME, size, SHA-256, status, and download.

The result column is a per-conversation layout state rather than a global modal. `data-result-open` makes the main shell yield width to a 320px/36vw (or 300px/34vw at narrower desktop width) right column. `locate()` bridges back to the source timeline without closing the result view.

## Backstage, settings, memory, story, and canon

`Backstage` is a controlled Kobalte `Dialog` styled as a right-side sheet because Kobalte has no Sheet primitive. It provides overlay, modal semantics, focus trapping, Escape close, labelled title, and internal `Tabs`. Runtime controls open state and initial destination (`roles` or standalone `settings`); Backstage synchronizes its internal selected tab when the initial tab changes.

Character-side tabs are:

- **Relationship archive:** package identity, relationship-memory and history-read switches, relationship-scoped memory list, and roleplay status/collections.
- **Role management:** directory/file import to `characters.import`, role listing, activation, and plugin trust review/confirmation before imported behavior is enabled.
- **Memory:** direct scoped records and pending candidates.
- **Story archive:** global or branch-only story changes, revert, and reset; story proposals are also surfaced in the main stage for accept/dismiss.
- **Package workshop / Canon Studio:** character draft authoring and canon source/module management.

Memory lists call `memory.list` for an empty query and `memory.search` for a non-empty query, cap UI search input at 512 characters, and guard against stale responses with a request sequence. Edit, forget, and exclude route through store memory methods. Exclude is locally optimistic because the list response does not echo the excluded flag; failures leave the toggle unchanged and show an alert. Pending candidates can be edited/approved with a scope or rejected; store mutations refetch candidates and entries.

Canon Studio loads sources/modules on mount. It adds/removes named sources, searches source chunks, and upserts/deletes typed modules (`root`, `arc`, `event`, `entity`, `relationship`, `location`, `object`, `behavior`) with optional parent and selected source chunks. The store refreshes the corresponding list after every mutation.

Character package authoring is not implemented in the renderer yet: [`CharacterPackageWorkshop.tsx`](../../packages/companion-ui/src/features/CharacterPackageWorkshop.tsx) presents a disabled-editor notice and links to the external authoring guide. The store does expose a revision-aware draft API (`draftCreate/Get/Patch`, asset upload, revision list/restore, validate, publish) for callers that implement authoring. Draft publish and character activation clear active conversation projection, resync onboarding, refresh characters/conversations, and refetch the snapshot. Canon and package UI therefore remain Host-backed rather than maintaining independent durable copies.

## Character scene, presence, and roleplay media

Runtime chooses the active scene from the active conversation’s character runtime scene ID, falling back to the character visual default scene. `SceneBackdrop` renders only a Host-provided `backgroundUrl`; package assets are converted by the Host to data URLs before reaching the sandboxed renderer.

`CharacterPresence` chooses an explicit runtime visual state when present, otherwise maps store presence to `presence`, `listening`, `thinking`, `needs_user`, `result_ready`, or `problem`. It falls back to the character’s default expression and exposes the package expression label through a `role="img"` wrapper while the image itself has empty alt text.

Roleplay state is snapshot-backed; media and choice presentation IDs are event-projected. Choice sets render inline and call `triggerRoleplayEvent`, which sends a conversation-scoped event with a random dedupe key, clears the selected choice set, and refetches the snapshot. Media has three presentation modes:

- `inline`: rendered in the conversation with a close button;
- non-inline/non-ambient: rendered in a Kobalte dialog overlay with title, close button, and focus behavior;
- `ambient` audio: rendered as a fixed player with stop control.

Audio/video use autoplay plus controls, loop metadata, URLs and optional captions. Animation images switch to `posterUrl` under `prefers-reduced-motion: reduce`. Backstage roleplay archives show only non-hidden variables and unlocked collections, with lazy image media and metadata-preloaded audio/video.

## Accessibility, i18n, and visual conventions

Kobalte primitives are used for Button, Dialog, Tabs, Select, TextField, FileField, Checkbox, Collapsible, and Link. This supplies keyboard interaction and accessible relationships for the complex controls. The code additionally uses:

- `aria-label`/`aria-labelledby` on shell, thread, dialogs, media, fields, and result tabs;
- `aria-live` for conversation, streaming and story-confirmation updates;
- `role="alert"` for operation/setup failures and `role="status"` for successful/ongoing feedback;
- `aria-current` for the active conversation, `aria-expanded` for message menus, `aria-pressed` for correction scopes/exclude controls, and visible focus return when closing ResultSpace;
- reduced-motion handling for global CSS animations and animation media.

All user-facing strings in the reviewed components come from `@bear-harness/i18n` via `useTranslation`/`i18n`; role package copy is rendered from validated character data. Product locale selection uses `setProductLocale`, persists to local storage in the i18n package, and updates the document language. Runtime compares the character language with the browser’s preferred language and shows a dismissible, non-blocking warning.

`styles.css` imports Tailwind v4 and defines semantic theme tokens for night/paper surfaces, text, muted text, accent, green, amber, danger, line, shadow, and body/heading fonts. The character theme can override surface/text/accent/radii/fonts through CSS custom properties on `.app`. Shared command/primary/select styles use these variables, and `:focus-visible` outlines are defined for buttons and textareas. Layout is deliberately desktop-oriented (`body` has 1050px minimum width and 680px minimum height); the only shell width adjustment is the 1200px breakpoint. CSS also owns scene/presence animation, thin scrollbars, result-column sizing, work states, and reduced-motion suppression.

## Error and security boundaries

- `invoke` unwraps the IPC envelope and converts failed calls/bridge exceptions to renderer errors.
- `stores/ipc.ts` narrow guards reject malformed Host payloads; the store does not project rejected data.
- Snapshot failure and event subscription failure are retried/resynced; sequence gaps discard the optimistic event projection.
- Store core actions generally catch failures into `store.error`; feature sheets also keep local error/feedback so an operation can report its own context. Some supplementary store methods intentionally let the rejection reach the calling sheet, which then displays it.
- Credentials are entered in password fields with autocomplete disabled and are passed only to provider APIs; UI displays a stored/session-only placeholder instead of the key.
- Artifact previews use Host-issued safe URLs or Host-returned bytes, never arbitrary renderer paths or constructed file URLs. Downloads create a short-lived Blob URL and revoke it.
- Character and package assets are Host-provided URLs/data; the renderer does not read package files directly. Imported package bytes are explicitly encoded and sent through `characters.import`.
- Media and text are rendered as DOM content; artifact Markdown is not HTML-rendered.

## Known issues / findings

These are current implementation findings, not proposed behavior:

1. **Source summary does not use the same version-adoption rule as message display.** `MessageItem` uses `adoptedVersion`, but `ResultSpace` derives its trigger-message summary from `message.versions.at(-1)`. If a user adopts an older version, the result header can describe a different version than the visible message. See [`ConversationPanel.tsx`](../../packages/companion-ui/src/ConversationPanel.tsx) and [`features/ResultSpace.tsx`](../../packages/companion-ui/src/features/ResultSpace.tsx).
2. **The nominal token system is not exhaustive.** `styles.css` defines semantic variables, but several component rules still use literal Tailwind colors/rgba values (for example sidebar backgrounds, result/work surfaces, focus colors, and image-routing error color). This makes character-theme overrides less predictable and should be considered when adding themed surfaces. See [`styles.css`](../../packages/companion-ui/src/styles.css).
3. **Desktop minimum dimensions are hard constraints.** `body` sets `min-width: 1050px`, `min-height: 680px`, and `overflow: hidden`; the responsive behavior only changes sidebar/result widths at 1200px. A smaller embedded window will not become a conventional single-column mobile layout.
4. **Ambient roleplay audio is presentation-state-only.** Dismissing ambient media clears the renderer’s active ID; there is no corresponding Host stop RPC in the store. Re-rendering from a later snapshot/event can present the same ambient item again if the Host continues to report it.
5. **The optional ResultSpace helper masks all context errors.** `WorkPanel` catches any error from `useResultSpace`, not only the expected missing-provider error. This helps isolated rendering but can hide an unrelated provider/runtime defect from maintainers.
6. **Some media caption fallbacks are synthetic or empty.** Artifact audio/video generates a full-duration VTT track whose text is the logical filename. Roleplay audio/video passes `captionsUrl ?? ""` in the conversation renderer, while archive media passes the possibly undefined URL directly. This is accessible markup, but it is not equivalent to real captions and may produce a request for an empty track URL.
7. **Supplementary errors have two presentation paths.** Core message actions set the shared store error, whereas memory/provider/settings/canon/work operations often let the rejection reach a component-local error/feedback handler. A maintainer adding a new store method must choose deliberately; otherwise the operation may fail without the thread-level alert expected by users.
8. **The `role="application"` shell changes assistive-technology semantics.** The root intentionally advertises an application landmark, while nested `main`, `aside`, `section`, live regions, and dialogs provide the actual navigation structure. Any new global keyboard shortcut should be checked against this mode and the existing `⌘/Ctrl+K` search handler.

## Verification commands

The package declares these commands in [`package.json`](../../packages/companion-ui/package.json):

```sh
npm --prefix packages/companion-ui run build
npm --prefix packages/companion-ui run typecheck
npm --prefix packages/companion-ui run test:unit
npm --prefix packages/companion-ui run test:coverage
```

`build` and `typecheck` both run TypeScript with `--noEmit`. The unit/coverage scripts first build the local `product-config`, `i18n`, `protocol`, and `companion-client` packages, then run Vitest. [`vitest.config.ts`](../../packages/companion-ui/vitest.config.ts) uses jsdom, `vite-plugin-solid`, `tests/setup.ts`, and `tests/**/*.spec.{ts,tsx}`; coverage is V8 under `coverage/ui` with 80% statement/function/line and 70% branch thresholds (excluding declaration files and `NetworkAndMemorySettings.tsx`).

The test suite covers the main contracts described above, including boot/idle shell and accessibility landmarks, onboarding authority/order and first-meeting setup, composer model/image routing and abort, message projection/operations, store/client RPC contracts, event/IPC validation, memory actions/candidates, model/provider settings, network/vector settings, Backstage role/story/memory journeys, work-run controls, ResultSpace/artifact preview, roleplay presentation, locale-switch store stability, and renderer diagnostics. Focused files are listed under [`packages/companion-ui/tests`](../../packages/companion-ui/tests).
