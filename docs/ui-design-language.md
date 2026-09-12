# Scene-facing UI design language

The approved Pi projection review establishes one visual language for the desktop product,
not a fixed character theme. Character package backgrounds, expressions and semantic
theme values remain authoritative; no scene or expression is hard-coded into components.

## Surface hierarchy

- Scene and standing character: independent visual layers, with the original asset composition preserved.
- Conversation: one locally translucent reading plane; assistant prose is unboxed and user messages remain distinct.
- Pi tools and thinking: lightweight vertical rails at their native timeline positions. Each tool stays visible; only verbose details collapse.
- Run outcomes, permissions and artifacts: contained cards, with failure treatment based on actual Run status, not tool-call completion.
- Composer, navigation, settings, onboarding and viewers: denser glass planes; inputs and nested cards use solid inset surfaces.
- Reduced transparency: replace translucent planes with opaque semantic surfaces without hiding the scene or character.

## Shared rules

Use semantic tokens in `base.css`; surface recipes live in `refinement.css`. Keep all
responsive geometry in `layout.css`. Use sans-serif body copy, 16px conversation text,
14px controls, and 12px secondary metadata. Preserve focus outlines, native disclosure
keyboard behavior and mobile touch targets. Do not apply opacity to containers holding text.

Desktop places conversation before the standing character. The duplicate scene label is
hidden only on desktop. Mobile retains a dense header and an independent background
character layer. Result selection still uses two main columns at 1600px+, a drawer at
768–1599px and a full-screen workspace on phones; the character yields to the wide result.

## Ownership and review

This redesign changes presentation only. Pi owns messages, chronology, streaming and tool
execution. Bear owns Run/Artifact surfaces and local viewer selections. No new runtime
flags, replay store, Character/Display writes or automatic result opening are introduced.

Review conversation, settings, onboarding, role management, permission dialogs and results
at phone, window and fullscreen sizes. Use the DOM site-map suite for surface reachability,
native projection tests for disclosure continuity, and the design-language browser test for
reading-plane and character geometry. Package signing and release gates remain separate.

## Review implementation report

- Scope: 3 code modules (companion-ui, i18n, web-dev), 16 files including this document.
- Measured review diff before this report: 521 added / 67 removed lines across the selected files, including the new browser test and this design note. Existing unrelated onboarding/executor work is excluded; overlapping style files retain earlier requested edits.
- Ownership: UI-only chronology classification and connectors; package identity is edited directly at its YAML path, separately from supplemental prompt text and System Prompt. No Host execution or persistence changes.
- Verification: UI typecheck and design-language/atomic-style checks passed; 39 selected UI tests plus 16 focused media/editor tests passed; all 8 browser tests passed (three viewport designs, three full surface journeys, two native projection journeys).
- Web build passed before the final timeline/editor refinement; final source passed typecheck and browser compilation. Full release gates were not run.
- Remaining review: custom backgrounds beyond the bundled examples, very long mixed-content timelines, platform-specific transparency performance, Electron/package smoke and final production build.
- Release decision: local review only. Not committed, tagged, packaged or released.

## Persona editor follow-up

The persona section edits `behavior.identity`, `behavior.agency`, `behavior.interaction`,
paired `behavior.examples`, and supplemental description/personality/scenario. Character
System Prompt remains a separate section writing only `prompt.system_prompt`. The editor
patches original YAML paths, retains revision-conflict checks, and never duplicates identity
into prompt description or changes scene, memory, state schema, plugin or runtime data.
List fields use one item per line; the Host remains authoritative for package validation.
Changes do not hot-reload an already-open Pi handle.

Navigation tabs retain full width. Action buttons occupy the secondary line without
reserving title width; conversation rows do not flex-shrink and only the list scrolls when
its content actually exceeds the available height. Narrow desktop hides shortcut badges.

Follow-up verification: UI typecheck, Web build, semantic style checks and test-quality
checks passed. Four targeted unit files passed (13 tests); after adding save/focus coverage,
the two focused editor files passed (8 tests). Three complete surface journeys passed,
and four design checks passed at 390/854/1280/1920 CSS pixels. The follow-up touches three
code modules and 12 files including this report; the new YAML editing helper is 56 lines
and its dedicated unit suite is 50 lines. Existing dirty work is retained. Browser zoom
was covered by narrow CSS viewport geometry, not every platform's native zoom control.
Release decision remains local review only; full release gates and packaged smoke were
not run. Host validation remains required for invalid/empty mandatory persona fields.

## Screenshot polish follow-up

One UI module, five source/test files (4,630 total lines, not changed-line count), plus this
report: textarea borders/insets/focus, role avatar and label spacing, compact non-overlapping
response actions, readable table column minimums, and suppression of invisible assistant
tool envelopes in the virtualized view. Tool arguments still come from the full authoritative
projection. Pi transcript data and package files are unchanged. Active-role avatars reuse
the already-loaded package image; other omitted list thumbnails show an initial instead of
an empty circle, preserving bounded summary payloads.

Verified actual in-app screenshots for role settings and the user's long table, UI typecheck,
style/format checks, 22 selected unit tests and then the expanded 13-test tool suite, plus
five browser journeys covering three layouts and native streaming/history. The last table
and toolbar spacing refinements were checked in the real page after those browser journeys.
No release/package smoke was run; decision remains local review, not a public release.

## Mainline structural review (v2)

Scope: one UI module plus localization and WebDev regression coverage; eight core
source/test files totaling 6,547 lines before the final result-label addition, plus
three locale files and this report. These are file sizes, not new-line counts; the
working tree also retains earlier unrelated work.

Virtual rows now own one 40px marker/content gutter for speech, reasoning, tools,
media and external-result cards. A reactive pass over the complete visible Pi
projection adds one character heading after each user boundary, not one heading per
assistant fragment. Native identities, order, transient streaming and tool arguments
remain authoritative and unchanged. Pagination can show a heading at the beginning
of the loaded window; loading older entries recomputes this display-only grouping.

Response operations share one footer, reasoning has no correction action, and user
edit/copy controls occupy a separate desktop hover/focus toolbar. Consecutive process
rows share an 8px virtual gap and continuous rail. Known tool actions get localized
labels; unrecognized actions retain their tool names. Media and Run results keep their
separate viewers and ownership. The composer and latest-navigation button now live
in one sticky dock, so multiline input cannot cover navigation.

Validation: UI typecheck; 17 selected unit tests (including response grouping and
reasoning-action exclusion); five Web browser journeys (1920/1280/390 layouts,
native streaming/disclosure continuity, history anchoring). Browser assertions cover
tool/footer left alignment, 28px desktop user controls, aligned response controls,
and clicking latest-navigation above an expanded multiline composer. Actual in-app
screenshots and media open/close were checked against the user's existing transcript.
Design-language, atomic-style and test-quality checks pass. Native mobile keyboard
behavior and packaged Electron smoke remain unverified. No Host authority or stored
transcript changes. Release decision: local review only, no commit or public release.

Heading follow-up: one UI module, three implementation/test files plus this report.
Long first-response navigation now shares the character heading instead of occupying
a second row; the existing native message-end anchor remains the scroll target.
UI typecheck and 16 tool-projection unit tests pass, including a no-duplicate heading
navigation regression. The real long-table reply was visually checked in-app.
No runtime ownership changes; packaged/mobile-keyboard validation remains outstanding.

Retry interpolation follow-up: i18n/UI scope, three locale files and two test files.
The locale files plus catalog tests total 2,516 lines (file sizes, not added lines).
Retry counts/delays now use the configured single-brace delimiters; generated Taiwan
output was rebuilt. Twelve locale tests pass, including exact outputs in all three
languages and a catalog-wide doubled-delimiter guard. The UI regression sends a real
Pi retry event and checks rendered numeric counts/delay. No retry lifecycle or network
behavior changed: this fixes the exposed template, not the underlying fetch failure.
Release decision remains local review only; no public release or package smoke.

Send-follow fix: one UI helper and its DOM regression test now distinguish scrolling
gestures from typing/sending, and recheck the document bottom on the next send frame.
Two DOM tests and the native-history browser journey pass. No Pi lifecycle changes.
Read-only memory diagnosis found capture/vector records but no extracted relationship
records; no memory settings, records, or extraction jobs were changed. This UI fix does
not establish the health of the complete relationship-memory pipeline.

## Memory logging and trace audit

Historical audit before the unified recorder implementation. See
[logging-system.md](logging-system.md) for current behavior and remaining work.

Two diagnostics modules, four implementation/test files: memory diagnostics retains
the upstream message alongside derived metadata. Credential patterns remain filtered;
paths, queries and counters remain in the owning character directory, not system logs.
The two-file rotation target remains 256 KiB; a single larger upstream message is
retained intact and can exceed that target. This is not an absolute byte quota or an
unlimited history. Previously stripped evidence cannot be recovered. Activation requires
a Host restart; no live conversation was interrupted for this change.

Trace audit: the current system log sample contains application lifecycle, RPC and
renderer faults, not complete Pi/model/tool or TDAI spans. `traceContent` has no
production call sites; when used it requires TRACE, caps text at 4096 bytes, and packaged
apps clamp TRACE off. Memory logs have no trace/span correlation. Catalog definitions
and passing storage tests therefore do not establish end-to-end observability.
This change restores memory diagnostic evidence only, not complete trace coverage.
Release decision: local changes only; no release or full live extraction validation.
