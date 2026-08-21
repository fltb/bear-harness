# Product configuration reference

> The directory name `docs/refernece/` is intentional. This document describes the
> current shared configuration, not a proposed configuration system.

## Responsibility and boundaries

`@bear-harness/product-config` is the compile-time source of release identity and
brand metadata. Its only runtime export is `productConfig` from
[`packages/product-config/src/index.ts`](../../packages/product-config/src/index.ts).
The package is private, publishes ESM and declaration output from `dist/`, and
has no runtime dependencies ([`package.json`](../../packages/product-config/package.json)).

The configuration is deliberately injected into existing application and host
entrypoints rather than read from an arbitrary user file:

- The Electron main process imports it directly, gives it to `createHostRuntime`,
  and uses it for the user-data directory, window title, and update service.
- The Electron renderer imports the same object and passes it to
  `CompanionApp`.
- Web Dev's loopback server imports the same object, passes it to
  `createHostRuntime`, and includes it in the `/bootstrap` response. The browser
  entrypoint passes that bootstrap value to `CompanionApp`.
- The companion UI accepts `Readonly<ProductConfig>` as an input. It does not
  choose a product identity itself; it uses the injected product name for the
  document title, application accessible name, and story-confirmation label.

This means a branded build should normally change product configuration,
branding assets, and character packages—not host-runtime, protocol, or UI domain
logic.

## Public API

### `BrandLicense`

`BrandLicense` is the declaration for the brand work carried by a build:

| Field | Type | Current value | Meaning |
| --- | --- | --- | --- |
| `spdx` | `"CC-BY-SA-4.0"` | `CC-BY-SA-4.0` | The only SPDX value accepted by the repository validator. |
| `workTitle` | `string` | `Cyber Bear Brand Assets` | Name of the licensed brand work. |
| `creator` | `string` | `fltb` | Creator/maintainer attribution; also used as the Linux package maintainer. |
| `attribution` | `string` | `fltb — Cyber Bear Brand Assets` | Human-readable attribution emitted into the build attribution file. |
| `sourceUrl` | `string` | `https://github.com/fltb/bear-harness` | Upstream/source location printed in attribution. |
| `modified` | `boolean` | `false` | Whether the brand work has been changed for this product. |
| `modificationNotice` | `string` | empty | Required to be non-empty when `modified` is `true`; empty is the official unmodified value. |

`BrandLicense` describes brand assets, not the code license. The root
[`BRAND-LICENSE`](../../BRAND-LICENSE) says the official name, character,
setting, copy, and visual assets are CC BY-SA 4.0, and that trademark rights
are not granted. It separately states that repository code remains GPL-3.0
under [`LICENSE`](../../LICENSE). Do not represent a fork's brand declaration
as relicensing the code.

### `ProductConfig`

| Field | Type | Current value | Consumer and contract |
| --- | --- | --- | --- |
| `productName` | `string` | `Cyber Bear` | Human-facing name. Electron uses it as the native window title; the UI uses it for `document.title`, the application `aria-label`, and the story confirmation heading. Electron-builder also uses it for package metadata and the Linux desktop entry name. |
| `appId` | `string` | `io.github.fltb.bear-harness` | Installation/application identity. Electron-builder maps it to `appId` and Linux `desktopName`; this must change for a fork to avoid identity collisions. The validator requires a reverse-domain form. |
| `dataDirectoryName` | `string` | `cyber-bear` | Product-specific suffix beneath Electron's app-data root. The desktop process sets `userData` to this directory and puts Chromium session data below it. Web Dev uses the same value through `webDevDataDirectory`; a fork must change it to isolate persisted state. |
| `artifactName` | `string` | `${productName}-${version}-${os}-${arch}.${ext}` | Electron-builder artifact filename template. The validator requires `${version}`, `${os}`, `${arch}`, and `${ext}` macros. |
| `executableName` | `string` | `cyber-bear` | Packaged binary name. The validator requires ASCII kebab-case; packaging and packaged-binary resolution use it on macOS, Windows, and Linux. |
| `defaultCharacterId` | `string` | `jizhou` | Default character-package ID passed into Host Runtime. It seeds default companion/memory namespaces and is used when no active character has been selected. It must correspond to a shipped or otherwise available character package, although the generic validator currently checks syntax only. |
| `brandLicense` | `BrandLicense` | See above | Attribution and modification declaration for the brand work. It drives Linux maintainer metadata and generated `BRAND-ATTRIBUTION.txt`. |
| `icon` | `string \| null` | `packages/product-config/assets/icon.png` | Repository-root-relative icon path, or `null` to omit a custom icon. Electron-builder resolves the path for macOS, Linux, and Windows. The generic validator accepts a readable `.png` (exactly 1024×1024) or readable `.svg`. |
| `updateFeedUrl?` | `string` | empty string | Optional desktop update feed. Empty or whitespace disables update checks. A non-empty URL enables the update service; see [Updates](#updates). |

The type declares `icon` as required (with `null` as the no-icon value), while
`updateFeedUrl` is optional so callers can omit it and let the desktop entrypoint
use `""` via `productConfig.updateFeedUrl ?? ""`.

## Official configuration and fork configuration

The official snapshot is duplicated intentionally in
[`apps/desktop/scripts/official-brand.mjs`](../../apps/desktop/scripts/official-brand.mjs).
The upstream release check compares these fields exactly:

- `productName`
- `appId`
- `dataDirectoryName`
- `artifactName`
- `executableName`
- `defaultCharacterId`
- `brandLicense`
- `icon`

The official snapshot does not include `updateFeedUrl`; the feed is an
operational release setting rather than part of the upstream brand identity.
[`check-upstream-brand.mjs`](../../apps/desktop/scripts/check-upstream-brand.mjs)
requires exact equality and `brandLicense.modified === false`, then reuses the
generic validator. That gate belongs to the upstream release pipeline. A fork
must remove or replace that job rather than trying to remain equal to the
official snapshot; the generic validator is the fork gate.

A representative accepted fork fixture is in
[`packages/companion-ui/tests/fixtures.ts`](../../packages/companion-ui/tests/fixtures.ts):
`North Companion` uses a new reverse-domain ID, data directory, executable,
character ID, brand attribution, modification notice, and `icon: null` while
leaving the artifact macro template intact. The fixture demonstrates that the
fork boundary is configuration plus character data, not UI/domain code.

## Branding and assets

The package currently contains one asset:

- [`packages/product-config/assets/icon.png`](../../packages/product-config/assets/icon.png)
  is the official icon referenced by the root-relative `icon` value.

Packaging resolves that path from the repository root and supplies it to all
three Electron-builder targets. Electron-builder also copies the root code
license, the root brand license, and the generated attribution file into
`extraResources`:

- `LICENSE` → `LICENSE`
- `BRAND-LICENSE` → `BRAND-LICENSE`
- `dist/brand/BRAND-ATTRIBUTION.txt` → `BRAND-ATTRIBUTION.txt`

The attribution file is generated by the product-config validator from
`BrandLicense`; it is not authored in the product-config package. A packaging
build therefore needs a successful validator run before electron-builder runs.

`productName` is not a replacement for character branding. Character scenes,
copy, and visual themes are loaded from character packages by Host Runtime.
`defaultCharacterId` selects the initial package; it does not embed that package
in `ProductConfig`.

## Injection and data/control flow

```mermaid
flowchart LR
  C[packages/product-config/src/index.ts<br/>productConfig] --> D[Electron main<br/>apps/desktop/src/main/index.ts]
  C --> R[Electron renderer<br/>apps/desktop/src/renderer/index.tsx]
  C --> W[Web Dev server<br/>apps/web-dev/server/index.ts]
  D --> H1[Host Runtime<br/>productConfig + dataDir]
  D --> UI1[CompanionApp<br/>productConfig]
  W --> B[/bootstrap<br/>product + token]
  B --> X[apps/web-dev/src/index.tsx]
  X --> UI2[CompanionApp<br/>bootstrap.product]
  R --> UI1
```

### Electron lifecycle

1. Before Electron is ready, the main process computes `userData` as
   `join(app.getPath("appData"), productConfig.dataDirectoryName)`, creates it
   and its `Chromium` child with mode `0700`, and sets Electron's `userData` and
   `sessionData` paths.
2. On `whenReady`, it constructs `UpdateService` from
   `productConfig.updateFeedUrl`, creates Host Runtime with the full
   `productConfig`, and starts the runtime. A missing/unavailable data store is
   reported as startup failure; the process does not silently substitute a
   default product configuration.
3. Once Host Runtime and artifact protocol setup succeed, the main process
   creates a `BrowserWindow` titled with `productName`. The packaged renderer
   imports the same config and passes it to the UI. Renderer isolation remains
   enabled (`contextIsolation`, sandbox, no Node integration); product config is
   not a mechanism for bypassing that boundary.
4. Shutdown closes the runtime and diagnostics before quitting. The update timer
   is cleared during `before-quit`.

The desktop entrypoint also limits development renderer navigation to the exact
loopback URL and only opens `https://` external links. Those controls are shell
security boundaries, not configurable branding behavior.

### Web Dev lifecycle

The Web Dev server computes its product data directory using
`productConfig.dataDirectoryName`, creates it with mode `0700`, creates the
Host Runtime with `productConfig`, and starts a loopback server. `GET /bootstrap`
returns `{ product: productConfig, token, debugEnabled }` without requiring the
bearer header so the browser can obtain its initial session. Subsequent RPC and
debug requests require the random per-process
`x-bear-web-dev-token` header and are bound to loopback.

`apps/web-dev/src/index.tsx` loads that bootstrap before rendering, creates the
HTTP transport with the token, installs renderer fault reporting, and renders
`<CompanionApp product={bootstrap.product} ...>`. The browser does not import
product-config directly, which keeps the server's product and host state in
lockstep.

### UI lifecycle

`CompanionApp` requires both an injected product and a client. Its runtime
creates the client-bound companion store, and `CompanionRuntime` sets
`document.title` from `productName`. The frame exposes the same name as its
accessible application label and in the story-confirmation UI. Product config
therefore affects shell identity; character themes still provide the visual CSS
variables for the active character.

## Validation and configuration lifecycle

Run the generic validator against the shared source before packaging:

```bash
node apps/desktop/scripts/validate-product-config.mjs --no-write
```

For a release build, omit `--no-write` so it validates and writes
`apps/desktop/dist/brand/BRAND-ATTRIBUTION.txt` (the script resolves its
`dist/brand` output relative to the desktop scripts directory):

```bash
node apps/desktop/scripts/validate-product-config.mjs
```

The validator performs these checks:

- `productName`, `appId`, `dataDirectoryName`, `artifactName`, and
  `executableName` are non-empty strings.
- `appId` matches the reverse-domain expression
  `^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$`.
- `dataDirectoryName` and `executableName` are ASCII kebab-case.
- `artifactName` contains all four required Electron-builder macros.
- `defaultCharacterId` is non-empty ASCII kebab-case.
- `brandLicense` is an object with the fixed CC BY-SA 4.0 SPDX value, non-empty
  identity strings, a boolean `modified`, and a string `modificationNotice`.
- `icon` is `null`, or a repo-relative existing `.png`/`.svg`; PNGs must be
  exactly 1024×1024 and readable.
- When any identity field differs from the official snapshot, `appId` and
  `dataDirectoryName` must both differ, `brandLicense.modified` must be `true`,
  and the modification notice must be non-empty.
- When no identity field differs, `brandLicense.modified` must be `false`.

The validator dynamically imports the selected config and exits non-zero for
load or validation errors. It has no silent fallback. The package's own compile
checks are:

```bash
npm run typecheck --workspace @bear-harness/product-config
npm run build --workspace @bear-harness/product-config
```

For an end-to-end fork check, build Web Dev and exercise its bootstrap/UI path,
then build and launch the desktop source or packaged target. Existing repository
entrypoints are:

```bash
npm run dev:web
npm run test:e2e:web
npm run check:electron
npm run package:mac       # or package:win / package:linux
npm run test:e2e:packaged
```

These commands are verification options; the product-config change itself does
not require changing application runtime code.

## Updates

The official value is `updateFeedUrl: ""`, so the desktop service starts in a
disabled state and its six-hour timer is a no-op. If a fork opts in, the feed may
be a JSON array or one object containing `version`, `url`, and `sha256`. Versions
are compared numerically by `major.minor.patch`; malformed or non-newer entries
are skipped. A missing `sha256` field is rejected when staging, while explicit
`sha256: null` intentionally skips checksum verification.

The service limits feed response size to 1 MiB, downloads only `http:` or
`https:` URLs, caps an archive at 2 GiB by default, stages under
`<userData>/updates/<version>/`, and verifies a provided 64-character SHA-256
hash before reaching `ready`. It does **not** perform code-signature or
notarization verification. A production fork enabling updates must add a
codesign/notarization trust gate in its release/update design; a checksum alone
is not equivalent to publisher authentication.

## Safe fork workflow

1. **Copy the configuration boundary.** Edit only
   `packages/product-config/src/index.ts` for product identity. Keep the
   `ProductConfig` shape and required artifact macros.
2. **Give the fork an isolated identity.** Change `productName`, `appId`,
   `dataDirectoryName`, `executableName`, and normally `artifactName`'s product
   prefix. Use a new `defaultCharacterId` and ship that character package under
   `config/characters`. Changing both `appId` and `dataDirectoryName` prevents
   installation and persisted-state collisions.
3. **Replace or remove visual identity.** Point `icon` to a new repo-relative
   1024×1024 PNG/SVG, or set it to `null`. Do not leave the official icon under a
   renamed product unless that is an intentional, licensed choice.
4. **Declare the brand license accurately.** Keep `spdx` at `CC-BY-SA-4.0` for
   adapted CC BY-SA brand assets. Set the fork's work title, creator,
   attribution, and source URL. Set `modified: true` and write a specific
   modification notice describing renamed/adapted assets. Retain the GPL code
   license and ship required notices; changing `BrandLicense` does not change
   code licensing or grant upstream trademark permission.
5. **Choose updates deliberately.** Leave `updateFeedUrl` empty until the fork
   has a trusted HTTPS distribution feed, complete checksums, and a signing /
   notarization trust gate. If enabled, publish feed entries that satisfy the
   update service contract.
6. **Validate and generate notices.** Run the generic validator with
   `--no-write`, fix every reported field, then run it without `--no-write` to
   generate the attribution file. Do not use the official upstream equality
   gate for the fork; remove or replace that upstream-only CI job.
7. **Verify packaging and both hosts.** Confirm the packaged filename/binary,
   icon, Linux metadata, generated attribution, isolated data directory, Web
   Dev `/bootstrap` product, Electron window title, and UI accessible name.
   Use the commands in [Validation and configuration lifecycle](#validation-and-configuration-lifecycle).

No host-runtime/domain implementation changes are needed for this workflow.

## Extension points

- Add or replace brand assets by changing `icon` and the asset file, without
  changing Electron-builder consumers.
- Add a character package and select it with `defaultCharacterId`; Host Runtime
  already receives that value as an option.
- Point a release at an update feed with `updateFeedUrl`, subject to the
  security limitations above.
- Add future product metadata by extending `ProductConfig` and then updating
  each typed transport boundary and consumer (notably Web Dev bootstrap) before
  relying on it. Existing fields are not a general arbitrary metadata bag.

## Known issues / findings

- **Runtime validation is external to the package.** `ProductConfig` is a
  TypeScript interface plus a plain object export; importing it does not invoke
  `validate-product-config.mjs`. A new consumer can construct or load an invalid
  object unless its build/release process runs the validator.
- **Character existence is not validated.** The validator checks the syntax of
  `defaultCharacterId` but not whether the ID exists under `config/characters`.
  Host Runtime later throws when it needs a missing character package. Fork
  validation should therefore include a character-package existence check in CI
  or a startup smoke test.
- **Web Dev's static bootstrap type is stale/incomplete.** The server returns the
  full `productConfig`, including `updateFeedUrl` when present, but
  [`apps/web-dev/src/http-client.ts`](../../apps/web-dev/src/http-client.ts)
  declares `WebDevBootstrap.product` only through `icon`. The current UI does
  not use the omitted field, so this is a compile-time contract mismatch rather
  than a current rendering failure.
- **The generic fork identity rule does not include `brandLicense` in
  `IDENTITY_FIELDS`.** A config that changes only brand-license identity fields
  while leaving every listed identity field equal to the official snapshot can
  pass generic identity-change detection with `modified: false`. The upstream
  exact-equality gate does compare `brandLicense`, but forks should still treat
  any brand change as modified and keep the declaration truthful.
- **`icon` has a type/validator edge mismatch.** The TypeScript type requires
  `string | null`, while the dynamic validator also accepts `undefined` as an
  omitted icon. Keep fork source typed (`null` when intentionally iconless)
  rather than relying on the looser dynamic path.
- **Repo-relative icon paths are documented but not enforced.** The validator
  resolves `config.icon` against the repository root and checks existence, but
  it does not reject an absolute path (or explicitly reject traversal before
  resolution). A fork should keep icon paths inside the repository and review
  this boundary if configuration can ever come from an untrusted source.
- **`updateFeedUrl` has no product-config schema validation.** The TypeScript
  field is optional and the generic validator does not check its type or URL
  scheme. The update service validates the feed's download URLs later, but a
  malformed feed URL fails only when the service checks it.
- **Generated attribution is a packaging prerequisite.** Electron-builder
  copies `dist/brand/BRAND-ATTRIBUTION.txt`, but product-config itself does not
  generate it. Skipping the validator's write step can make an otherwise valid
  configuration produce an incomplete artifact or a packaging failure.
- **Update transport is not publisher authentication.** The update pipeline
  verifies a checksum only when one is supplied and explicitly permits
  `sha256: null`; it has no code-signature/notarization check. Do not enable a
  fork's public update feed without adding that trust boundary.
- **The official icon is the only product-config asset.** Character visuals and
  other branded content are outside this package. Replacing only `icon` and
  `productName` does not replace the default character's name, scenes, or copy;
  change `defaultCharacterId` and ship the corresponding character package for a
  genuinely independent brand.
