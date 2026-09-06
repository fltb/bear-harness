#!/usr/bin/env node
// Source-E2E bootstrap for the production Pi ACP worker, never a fixture executor.
// apps/web-dev/scripts/dev.mjs builds host-runtime before starting the Host.
// Keep this shim at the repository root: the native sandbox mounts dependencies
// read-only while the isolated Run workspace and output directory stay writable.

import "./packages/host-runtime/dist/executors/pi-acp-worker.js";
