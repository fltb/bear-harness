# Promo production

- Promo stays a standalone application. Native preview uses the local Chromium window and physical GPU; it remains separate from Bear's Electron application.
- All promo-owned Chinese copy must exclude Unicode U+4E0D, including narration, titles, captions, scripted dialogue, demo memory, result text and overlays. Prefer direct, positive descriptions. Run `npm run check:copy` through the repository's fnm toolchain.
- Present the complete revised copy to the user for review. Voice synthesis, subtitle timing generation and video rendering require the user's explicit approval of that copy. Source edits, static checks and an empty-window GPU probe may run during review.
- Character source packages stay separate from the frozen production snapshot. `prepare-assets.mjs --freeze` creates a new local snapshot explicitly; regular preview verifies the retained snapshot.

- The user subsequently approved the exact scene question “你是不是每件都想留下？” and requested that copy be restored. Preserve this single approved question verbatim; the U+4E0D guard exempts only its exact scenario user field. All other promo copy retains the character ban.
