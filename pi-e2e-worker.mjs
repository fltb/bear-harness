#!/usr/bin/env node
// Source-E2E bootstrap for Pi ACP. Keeping it at the repository root lets the
// native sandbox read the worker's bare dependencies without writable access.

import "./packages/host-runtime/dist/executors/pi-acp-worker.js";
