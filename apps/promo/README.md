# Standalone promo

Run every command from the repository root with the pinned toolchain.

```sh
fnm exec --using=.nvmrc npm run check:copy --workspace @bear-harness/promo
fnm exec --using=.nvmrc node apps/promo/scripts/native.mjs --check-gpu
```

The GPU probe opens an empty native Chromium window, checks actual hardware compositing, writes `.local-output/native-gpu.json`, and exits. AMD, Intel and NVIDIA hardware are accepted; software renderers fail the check.

Prepare a frozen local snapshot from installed character packages once:

```sh
fnm exec --using=.nvmrc node apps/promo/scripts/prepare-assets.mjs --freeze
```

After the user approves the revised copy, generate narration and its measured subtitle timeline using `scripts/generate-audio.py`. Preview requires `.local-output/timeline.json`, narration audio and frozen media. The native launcher rejects narration that differs from the current slide source.

```sh
fnm exec --using=.nvmrc npm run dev --workspace @bear-harness/promo
```

This starts the independent Vite server and a native Chromium app window on the current desktop. Closing the window stops the server and removes its temporary browser profile. `PROMO_CHROMIUM` selects the local browser executable (default `/usr/bin/chromium`). `dev:web` starts only Vite for browser development.

The `export` command records the independently rendered Chromium surface on an isolated Linux X11 display using hardware GPU compositing. It selects NVIDIA NVENC or AMD/Intel VAAPI H.264 encoding, then muxes the approved narration as AAC. `PROMO_VAAPI_DEVICE` selects the render device (default `/dev/dri/renderD128`). The exporter rejects software renderers, stale narration and incomplete playback.

Private media, narration, exported video and evidence stay in the ignored `.local-content/` and `.local-output/` directories. Imported historical video and captions remain the previous version until a newly approved render replaces them.
